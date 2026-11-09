import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it } from "vitest";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const actualHost = it.runIf(process.platform === "linux" || process.platform === "darwin");

async function fixture(work: (runtime: any, backend: any, store: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-steering-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    const runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const backend = new HeadlessBackend(runtime, () => {});
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.authenticateOrigin = (origin: unknown) => origin;
    runtime.save({ version: 1, id: "job", fingerprint: "accepted", threadId: "native", turnId: "turn", status: "running", createdAt: new Date().toISOString() });
    runtime.active = "job";
    await work(runtime, backend, store);
  } finally { profile.close(); rmSync(root, { recursive: true, force: true }); }
}

const request = { backend: "codex", threadId: "native", expectedTurnId: "turn", requestId: "steer", input: [{ type: "text", text: "one input" }] };

const originFrom = (requestId: string) => ({ kind: "messaging", causalMessagingSource: { ownerId: "owner", requestId } });
const messagingCall = (operation = "send_private_response") => ({ operation, context: { backend: "codex", threadId: "native", turnId: "turn" }, args: {} });
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

actualHost("attributed steering fences messaging until native acceptance and durable origin retention settle", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("send_private_response", "send_messaging_file", "inspect_messaging_pdfs", "list_messaging_surfaces"),
    fc.boolean(), fc.boolean(), fc.integer({ min: 1, max: 4 }),
    async (operation, refuseNative, refuseRetention, copies) => {
      await fixture(async (runtime, backend, store) => {
        const original = originFrom("source-a");
        runtime.save({ ...store.get("job"), messageOrigin: original });
        const forwarded: any[] = [];
        runtime.requestMessaging = async (call: unknown) => { forwarded.push(call); return { ok: true }; };
        await runtime.messagingRequest(messagingCall(operation));
        expect(forwarded[0].context.causalMessagingSource).toEqual(original.causalMessagingSource);
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        let release!: () => void;
        const decision = new Promise<void>(resolve => { release = resolve; });
        let sends = 0;
        runtime.codex = { steerTurn: async () => {
          sends++; entered(); await decision;
          if (refuseNative) throw new Error("native refused");
          return { threadId: "native", turnId: "turn" };
        } };
        const save = store.save.bind(store);
        let refusals = refuseRetention ? 1 : 0;
        store.save = (job: any) => {
          if (job.messageOrigin?.causalMessagingAmbiguous && refusals-- > 0) throw new Error("origin refused");
          return save(job);
        };
        const params = { ...request, messageOrigin: originFrom("source-b") };
        const pending = Promise.allSettled(Array.from({ length: copies }, () => backend.handle("steerTurn", params)));
        try {
          await started;
          // Codex may issue the tool after accepting B but before resolving its RPC.
          expect(await runtime.messagingRequest(messagingCall(operation))).toMatchObject({ ok: false, error: { code: "forbidden" } });
          expect(forwarded).toHaveLength(1);
          expect(store.get("job").messageOrigin).toEqual(original);
        } finally { release(); await pending; }
        const outcomes = await pending;
        if (refuseNative || refuseRetention) expect(outcomes.every(result => result.status === "rejected")).toBe(true);
        if (!refuseNative && refuseRetention) {
          expect(await runtime.messagingRequest(messagingCall(operation))).toMatchObject({ ok: false, error: { code: "forbidden" } });
          expect(forwarded).toHaveLength(1);
          expect(store.get("job").messageOrigin).toEqual(original);
          await backend.handle("steerTurn", params);
        }
        expect(sends).toBe(1);
        await runtime.messagingRequest(messagingCall(operation));
        expect(forwarded).toHaveLength(2);
        if (refuseNative) {
          expect(forwarded[1].context.causalMessagingSource).toEqual(original.causalMessagingSource);
          expect(store.get("job").messageOrigin).toEqual(original);
        } else {
          expect(forwarded[1].context.causalMessagingSource).toBeUndefined();
          expect(forwarded[1].context.causalMessagingAmbiguous).toBe(true);
          expect(store.get("job").messageOrigin.causalMessagingAmbiguous).toBe(true);
        }
      });
    },
  ), { numRuns: 20, examples: [["send_private_response", false, true, 2], ["send_private_response", true, false, 1]] });
});

actualHost("each concurrent attributed steer owns its messaging fence until its own decision settles", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 0, max: 3 }), { minLength: 2, maxLength: 4 }), fc.boolean(), async (order, refuseOdd) => {
    await fixture(async (runtime, backend, store) => {
      runtime.save({ ...store.get("job"), messageOrigin: originFrom("source-a") });
      let forwards = 0;
      runtime.requestMessaging = async () => { forwards++; return { ok: true }; };
      const gates = new Map(order.map(id => [id, { started: gate(), decision: gate() }]));
      const pending = new Map<number, Promise<unknown>>();
      const unsettled = new Set(order);
      runtime.codex = { steerTurn: async (params: any) => {
        const id = Number(params.input[0].text);
        gates.get(id)!.started.release();
        await gates.get(id)!.decision.promise;
        if (refuseOdd && id % 2) throw new Error("native refused");
        return { threadId: "native", turnId: "turn" };
      } };
      try {
        for (const id of [...order].sort()) {
          const result = backend.handle("steerTurn", { ...request, requestId: `steer-${id}`, input: [{ type: "text", text: String(id) }], messageOrigin: originFrom(`source-${id}`) });
          pending.set(id, result);
          void result.catch(() => {});
          await gates.get(id)!.started.promise;
        }
        for (const id of order) {
          expect(await runtime.messagingRequest(messagingCall())).toMatchObject({ ok: false, error: { code: "forbidden" } });
          gates.get(id)!.decision.release();
          await Promise.allSettled([pending.get(id)!]);
          unsettled.delete(id);
          const result = await runtime.messagingRequest(messagingCall());
          expect(result.ok).toBe(unsettled.size === 0);
          expect(forwards).toBe(unsettled.size === 0 ? 1 : 0);
        }
      } finally {
        for (const { decision } of gates.values()) decision.release();
        await Promise.allSettled(pending.values());
      }
    });
  }), { numRuns: 16, examples: [[[0, 1], true], [[1, 0], true]] });
});

actualHost("terminal cleanup and late steer decisions cannot release another active job's messaging fence", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("completed", "failed", "interrupted"), fc.boolean(), async (status, refuseOld) => {
    await fixture(async (runtime, backend, store) => {
      const old = { started: gate(), decision: gate() };
      const next = { started: gate(), decision: gate() };
      runtime.codex = { steerTurn: async (params: any) => {
        const boundary = params.expectedTurnId === "turn" ? old : next;
        boundary.started.release();
        await boundary.decision.promise;
        if (boundary === old && refuseOld) throw new Error("late native refusal");
        return { threadId: "native", turnId: params.expectedTurnId };
      } };
      let forwards = 0;
      runtime.requestMessaging = async () => { forwards++; return { ok: true }; };
      const pending = [backend.handle("steerTurn", { ...request, messageOrigin: originFrom("old") })];
      void pending[0].catch(() => {});
      try {
        await old.started.promise;
        runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status } } });
        expect(runtime.pendingSteeringOrigins.size).toBe(0);
        runtime.save({ ...store.get("job"), id: "next", status: "running", turnId: "next-turn", createdAt: "2030-01-01T00:00:00.000Z", messageOrigin: originFrom("next") });
        runtime.active = "next";
        const call = { ...messagingCall(), context: { backend: "codex", threadId: "native", turnId: "next-turn" } };
        expect(await runtime.messagingRequest(call)).toMatchObject({ ok: true });
        pending.push(backend.handle("steerTurn", { ...request, expectedTurnId: "next-turn", messageOrigin: originFrom("next-steer") }));
        void pending[1].catch(() => {});
        await next.started.promise;
        old.decision.release();
        await Promise.allSettled([pending[0]]);
        expect(await runtime.messagingRequest(call)).toMatchObject({ ok: false, error: { code: "forbidden" } });
        expect(forwards).toBe(1);
        next.decision.release();
        await pending[1];
        expect(await runtime.messagingRequest(call)).toMatchObject({ ok: true });
        expect(store.get("job").status).toBe(status);
        expect(store.get("next").messageOrigin.causalMessagingAmbiguous).toBe(true);
      } finally {
        old.decision.release(); next.decision.release();
        await Promise.allSettled(pending);
      }
    });
  }), { numRuns: 12 });
});

actualHost("actual Outpost coalesces accepted steering and retries only refused origin completion", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.boolean(), fc.boolean(), async (copies, refuseOrigin, control) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const accepted = new Promise<void>(resolve => { release = resolve; });
      const incoming = { kind: "agent", systemReason: "steering-test" };
      const prior = store.get("job");
      runtime.codex = { steerTurn: async () => { sends++; entered(); await accepted; return { threadId: "native", turnId: "turn" }; } };
      const save = store.save.bind(store);
      let refusals = refuseOrigin ? 1 : 0;
      store.save = (job: any) => { if (job.messageOrigin && refusals-- > 0) throw new Error("origin refused"); return save(job); };
      const params = { ...request, messageOrigin: incoming, ...(control ? { operation: "steer" } : {}) };
      const invoke = () => backend.handle(control ? "controlActiveTurn" : "steerTurn", params);
      const pending = Array.from({ length: copies }, invoke);
      // Observe all rejections immediately, including the pre-fix origin write.
      const outcomes = Promise.allSettled(pending);
      if (!refuseOrigin) {
        await started;
        try { expect(store.get("job").messageOrigin).toBeUndefined(); }
        finally { release(); }
      }
      release();
      await outcomes;
      const result = await invoke();
      expect(result).toMatchObject({ backend: "codex", threadId: "native", turnId: "turn", disposition: "steered" });
      expect(sends).toBe(1);
      expect(store.get("job")).toMatchObject({ fingerprint: prior.fingerprint, status: "running", messageOrigin: incoming });
      for (const change of [{ input: [{ type: "text", text: "changed" }] }, { messageOrigin: { ...incoming, systemReason: "changed" } }, { delivery: "now" }]) {
        await expect(backend.handle(control ? "controlActiveTurn" : "steerTurn", { ...params, ...change })).rejects.toThrow();
      }
      expect(sends).toBe(1);
    });
  }), { numRuns: 16 });
});

actualHost("native refusal, unsupported delivery and handoff locks cannot acquire steering origin", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("provider", "lock", "delivery"), async refusal => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.threadLocked = () => refusal === "lock";
      runtime.codex = { steerTurn: async () => { sends++; throw new Error("native refused"); } };
      const params = { ...request, messageOrigin: { kind: "agent" }, ...(refusal === "delivery" ? { delivery: "now" } : {}) };
      await expect(backend.handle("steerTurn", params)).rejects.toThrow();
      expect(store.get("job").messageOrigin).toBeUndefined();
      expect(sends).toBe(refusal === "provider" ? 1 : 0);
    });
  }), { numRuns: 9 });
});

actualHost("steering completion preserves concurrent provider terminals and interruption retires only on terminal", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("completed", "failed", "interrupted"), fc.boolean(), async (status, rejectInterrupt) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.codex = {
        steerTurn: async () => { sends++; return { threadId: "native", turnId: "turn" }; },
        interruptTurn: async () => { if (rejectInterrupt) throw new Error("interrupt refused"); return {}; },
      };
      await backend.handle("steerTurn", request);
      if (rejectInterrupt) await expect(runtime.handle("interrupt", { id: "job" })).rejects.toThrow("interrupt refused");
      else await runtime.handle("interrupt", { id: "job" });
      await backend.handle("steerTurn", request);
      expect(sends).toBe(1);
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void;
      const accepted = new Promise<void>(resolve => { release = resolve; });
      runtime.codex.steerTurn = async () => { sends++; entered(); await accepted; return { threadId: "native", turnId: "turn" }; };
      const pending = backend.handle("steerTurn", { ...request, requestId: "terminal", messageOrigin: { kind: "agent" } });
      await started;
      runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status } } });
      release();
      const outcome = await Promise.allSettled([pending]);
      expect(outcome[0].status).toBe("fulfilled");
      expect(store.get("job")).toMatchObject({ status, threadId: "native", turnId: "turn", fingerprint: "accepted" });
      expect(runtime.active).toBeNull();
    });
  }), { numRuns: 12 });
});

actualHost("interrupt refusal restores only its captured active job and never replaces a provider terminal", async () => {
  await fc.assert(fc.asyncProperty(fc.option(fc.constantFrom("completed", "failed", "interrupted"), { nil: undefined }), async terminal => {
    await fixture(async (runtime, _backend, store) => {
      let reject!: (error: Error) => void;
      runtime.codex = { interruptTurn: () => new Promise((_resolve, fail) => { reject = fail; }) };
      const pending = runtime.handle("interrupt", { id: "job" });
      expect(store.get("job").status).toBe("interrupting");
      if (terminal) runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn", status: terminal } } });
      reject(new Error("native refusal"));
      await expect(pending).rejects.toThrow("native refusal");
      expect(store.get("job")).toMatchObject({ status: terminal ?? "running", threadId: "native", turnId: "turn" });
    });
  }), { numRuns: 12 });
});
