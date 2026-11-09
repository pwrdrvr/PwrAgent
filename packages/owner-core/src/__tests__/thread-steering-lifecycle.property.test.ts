import fc from "fast-check";
import { expect, it, vi } from "vitest";
import type { AppServerThreadMessageOrigin, SteerTurnRequest, SteerTurnResponse } from "@pwragent/shared";
import { ThreadSteeringLifecycle } from "../thread-steering-lifecycle";

const backend = fc.constantFrom<SteerTurnRequest["backend"]>("codex", "claude", "acp:kimi", "acp:claude");
const target = fc.record({ backend, threadId: fc.constantFrom("shared", "other", "shared\u0000turn"),
  expectedTurnId: fc.constantFrom("turn", "other", "turn\u0000request"), requestId: fc.constantFrom("request", "other") });
const request = (id: Partial<SteerTurnRequest> = {}): SteerTurnRequest => ({ backend: "codex", threadId: "thread",
  expectedTurnId: "turn", requestId: "request", input: [{ type: "text", text: "Steer" }], ...id });
const response = (params: SteerTurnRequest): SteerTurnResponse => ({ backend: params.backend, threadId: params.threadId,
  turnId: params.expectedTurnId, disposition: "steered" });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

// Model: provider rejection admits nothing; provider acceptance is retained even
// when host completion fails. Only successful completion is cached as finished.
// Retirement removes exactly one backend/thread/expected-turn scope.
it("matches the admission, failure recovery and retirement model across generated commands", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ id: target,
    action: fc.constantFrom("send", "send", "retire", "clear"), payload: fc.boolean(),
    providerFails: fc.boolean(), retentionFails: fc.boolean(), completionFails: fc.boolean(), queued: fc.boolean(),
  }), { minLength: 1, maxLength: 80 }), async (operations) => {
    const model: Array<{ id: typeof operations[number]["id"]; payload: boolean; retained: boolean; complete: boolean;
      result: SteerTurnResponse }> = [];
    let current = operations[0];
    const retain = vi.fn(async () => { if (current.retentionFails) throw new Error("retention"); });
    const submit = vi.fn(async (params: SteerTurnRequest) => {
      if (current.providerFails) throw new Error("provider");
      return { response: { ...response(params), disposition: current.queued ? "queued" as const : "steered" as const },
        complete: retain };
    });
    const complete = vi.fn(async () => { if (current.completionFails) throw new Error("completion"); });
    const lifecycle = new ThreadSteeringLifecycle({ submit, complete });
    let submissions = 0;
    let retentions = 0;
    let completions = 0;
    for (const op of operations) {
      current = op;
      const sameTurn = (entry: typeof model[number]) => entry.id.backend === op.id.backend
        && entry.id.threadId === op.id.threadId && entry.id.expectedTurnId === op.id.expectedTurnId;
      if (op.action === "clear" || op.action === "retire") {
        for (let i = model.length - 1; i >= 0; i -= 1) {
          if (op.action === "clear" || sameTurn(model[i])) model.splice(i, 1);
        }
        if (op.action === "clear") lifecycle.clear();
        else lifecycle.retireTurn({ ...op.id, turnId: op.id.expectedTurnId });
        continue;
      }
      let entry = model.find((candidate) => sameTurn(candidate) && candidate.id.requestId === op.id.requestId);
      const params = request({ ...op.id, input: [{ type: "text", text: String(op.payload) }] });
      let error: string | undefined;
      if (entry && entry.payload !== op.payload) error = "reused with different input";
      else if (!entry || !entry.complete) {
        if (!entry) {
          submissions += 1;
          if (op.providerFails) error = "provider";
          else {
            entry = { id: op.id, payload: op.payload, retained: false, complete: false,
              result: { ...response(params), disposition: op.queued ? "queued" : "steered" } };
            model.push(entry);
          }
        }
        if (entry) {
          if (!entry.retained) {
            retentions += 1;
            if (op.retentionFails) error = "retention";
            else entry.retained = true;
          }
          if (!error) {
            completions += 1;
            if (op.completionFails) error = "completion";
            else entry.complete = true;
          }
        }
      }
      if (error) await expect(lifecycle.steerTurn(params)).rejects.toThrow(error);
      else expect(await lifecycle.steerTurn(params)).toEqual(entry!.result);
      expect(submit).toHaveBeenCalledTimes(submissions);
      expect(retain).toHaveBeenCalledTimes(retentions);
      expect(complete).toHaveBeenCalledTimes(completions);
    }
  }));
});

it("shares pending provider retention before causal completion across duplicate callers", async () => {
  await fc.assert(fc.asyncProperty(target, fc.integer({ min: 2, max: 8 }), fc.boolean(), async (id, copies, fail) => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const retain = vi.fn(async () => { entered.resolve(); await gate.promise; });
    const submit = vi.fn(async (params: SteerTurnRequest) => ({ response: response(params), complete: retain }));
    const complete = vi.fn(async () => {});
    const lifecycle = new ThreadSteeringLifecycle({ submit, complete });
    let settled = 0;
    const calls = Array.from({ length: copies }, () => lifecycle.steerTurn(request(id)).finally(() => { settled += 1; }));
    const outcomes = Promise.allSettled(calls);
    await entered.promise;
    expect(settled).toBe(0);
    expect(complete).not.toHaveBeenCalled();
    if (fail) gate.reject(new Error("retention"));
    else gate.resolve();
    expect((await outcomes).map((item) => item.status)).toEqual(Array(copies).fill(fail ? "rejected" : "fulfilled"));
    retain.mockResolvedValue(undefined);
    expect(await lifecycle.steerTurn(request(id))).toEqual(response(request(id)));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(fail ? 2 : 1);
    expect(complete).toHaveBeenCalledTimes(1);
  }));
});

it("shares host completion and its failure among all generated duplicate callers", async () => {
  await fc.assert(fc.asyncProperty(target, fc.integer({ min: 2, max: 10 }), fc.boolean(), async (id, copies, fail) => {
    const gate = deferred<void>();
    const entered = deferred<void>();
    const submit = vi.fn(async (params: SteerTurnRequest) => ({ response: response(params) }));
    const complete = vi.fn(async () => { entered.resolve(); await gate.promise; });
    const lifecycle = new ThreadSteeringLifecycle({ submit, complete });
    let settled = 0;
    const calls = Array.from({ length: copies }, () => lifecycle.steerTurn(request(id))
      .then((value) => { settled += 1; return value; }, (error: unknown) => { settled += 1; throw error; }));
    const outcomes = Promise.allSettled(calls);
    await entered.promise;
    expect(settled).toBe(0);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    if (fail) gate.reject(new Error("completion"));
    else gate.resolve();
    expect((await outcomes).map((item) => item.status)).toEqual(Array(copies).fill(fail ? "rejected" : "fulfilled"));
    complete.mockResolvedValue(undefined);
    expect(await lifecycle.steerTurn(request(id))).toEqual(response(request(id)));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(fail ? 2 : 1);
  }));
});

it("never lets retired work evict or overwrite a newer request with the same identity", async () => {
  await fc.assert(fc.asyncProperty(target, fc.constantFrom("provider", "retention", "causal"), fc.boolean(), async (id, stage, clear) => {
    const entered = deferred<void>();
    const gate = deferred<SteerTurnResponse>();
    const params = request(id);
    const submit = vi.fn(async () => ({ response: response(params) }));
    const complete = vi.fn(async () => {});
    if (stage === "provider") submit.mockImplementationOnce(async () => { entered.resolve(); return { response: await gate.promise }; });
    else if (stage === "retention") submit.mockImplementationOnce(async () => ({ response: response(params),
      complete: async () => { entered.resolve(); await gate.promise; } }));
    else complete.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; });
    const lifecycle = new ThreadSteeringLifecycle({ submit, complete });
    const old = lifecycle.steerTurn(params).catch((error: unknown) => error);
    await entered.promise;
    if (clear) lifecycle.clear();
    else lifecycle.retireTurn({ ...params, turnId: params.expectedTurnId });
    expect(await lifecycle.steerTurn(params)).toEqual(response(params));
    gate.reject(new Error("old work"));
    expect(await old).toBeInstanceOf(Error);
    expect(await lifecycle.steerTurn(params)).toEqual(response(params));
    expect(submit).toHaveBeenCalledTimes(2);
  }));
});

it("admits before a synchronous host can reenter with the same request", async () => {
  const params = request();
  let duplicate: Promise<SteerTurnResponse> | undefined;
  const submit = vi.fn(async () => {
    duplicate = lifecycle.steerTurn(params);
    return { response: response(params) };
  });
  const lifecycle = new ThreadSteeringLifecycle({ submit, complete: async () => {} });
  expect(await lifecycle.steerTurn(params)).toEqual(response(params));
  expect(await duplicate).toEqual(response(params));
  expect(submit).toHaveBeenCalledTimes(1);
});

it("ignores optional ancestry on retries while fencing every meaningful input, origin and delivery change", async () => {
  await fc.assert(fc.asyncProperty(target, fc.string(), fc.string(), async (id, turnId, rootTurnId) => {
    const submit = vi.fn(async (params: SteerTurnRequest) => ({ response: response(params) }));
    const lifecycle = new ThreadSteeringLifecycle({ submit, complete: async () => {} });
    const params = request(id);
    const origin: AppServerThreadMessageOrigin = { kind: "agent", sourceThread: { backend: "codex", threadId: "sender" } };
    await lifecycle.steerTurn(params, origin);
    await lifecycle.steerTurn(params, { ...origin, sourceThread: { ...origin.sourceThread!, turnId, rootTurnId } });
    const changes: Array<[SteerTurnRequest, AppServerThreadMessageOrigin]> = [
      [{ ...params, input: [{ type: "text", text: "Other" }] }, origin],
      [{ ...params, delivery: "now" }, origin],
      [params, { ...origin, kind: "messaging" }],
      [params, { ...origin, sourceThread: { ...origin.sourceThread!, threadId: "other" } }],
      [params, { ...origin, causalMessagingAmbiguous: true }],
    ];
    for (const [changed, changedOrigin] of changes) {
      await expect(lifecycle.steerTurn(changed, changedOrigin)).rejects.toThrow("reused with different input");
    }
    expect(submit).toHaveBeenCalledTimes(1);
  }));
});
