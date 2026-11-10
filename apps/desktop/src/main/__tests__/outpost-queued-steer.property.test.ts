import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const ref = { backend: "codex" as const, threadId: "native" };
const drain = async () => { for (let i = 0; i < 24; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(work: (f: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-qsteer-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const steers: any[] = [], starts: any[] = [], events: any[] = [];
    runtime.codex = {
      startTurn: async (request: any) => { starts.push(request); return { threadId: request.threadId, turnId: `turn-${starts.length}` }; },
      steerTurn: async (request: any) => { steers.push(request); return { threadId: request.threadId, turnId: request.expectedTurnId }; },
      stop: async () => {},
    };
    const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime, profile: "fixture", onFailure() {} });
    federation.ensureIdentity("fixture");
    federation.publish = (event: any) => events.push(event.notification);
    const backend = federation.backend;
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    const envelope = { sourceInstanceId: "issuer", targetInstanceId: federation.state.instanceId, id: "transport" };
    const value = (id: string, text = id) => ({ ...ref, queueEntryId: id, input: [{ type: "text", text }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: `sender-${id}`, instanceId: "untrusted-claim" } } });
    const submit = (request: any) => backend.handle("backend.startTurn", request, envelope);
    const terminal = (turnId = "turn-1", status = "completed") => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: turnId, status } } });
    runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" });
    await runtime.work;
    await work({ root, runtime, backend, federation, store, profile, steers, starts, events, submit, value, terminal, envelope });
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("each accepted default agent input steers once under its own immutable identity and retains the native owner", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 1, max: 4 }), async (count, copies) => {
    await fixture(async ({ runtime, backend, store, steers, starts, events, submit, value, terminal }: any) => {
      const accepted: any[] = [];
      for (let i = 0; i < count; i++) {
        const request = value(`message${i}`, `private-${i}`);
        const result = await submit(request);
        accepted.push({ request, id: result.queueEntryId, fingerprint: store.get(result.queueEntryId).fingerprint });
        for (let j = 0; j < copies; j++) expect((await submit(request)).queueEntryId).toBe(result.queueEntryId);
      }
      await drain();
      expect(steers.map((request: any) => request.input[0].text), JSON.stringify(runtime.turnQueue.getQueuedEntries(ref))).toEqual(accepted.map(({ request }) => request.input[0].text));
      expect(steers.every((request: any) => request.expectedTurnId === "turn-1")).toBe(true);
      expect(starts).toHaveLength(1);
      expect(runtime.active).toBe("active");
      expect(backend.activeJob(ref).id).toBe("active");
      expect(runtime.turnQueue.getQueuedEntries(ref)).toEqual([]);
      for (const { request, id, fingerprint } of accepted) {
        expect(store.get(id)).toMatchObject({ fingerprint, status: "running", threadId: ref.threadId, turnId: "turn-1",
          messageOrigin: { sourceThread: { instanceId: "issuer" } } });
        expect(JSON.stringify(store.get(id))).not.toContain("private-");
        await expect(submit({ ...request, input: [{ type: "text", text: "changed" }] })).rejects.toThrow("different input");
        await expect(submit({ ...request, delivery: "new_turn" })).rejects.toThrow("different input");
        expect(events.some((event: any) => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === id && event.params.status === "started" && event.params.turnId === "turn-1")).toBe(true);
      }
      terminal(); await drain();
      for (const { request, id, fingerprint } of accepted) {
        expect(store.get(id)).toMatchObject({ fingerprint, status: "completed", turnId: "turn-1" });
        expect((await submit(request)).queueEntryId).toBe(id);
      }
      expect(steers).toHaveLength(count);
      expect(starts).toHaveLength(1);
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("delivery-less accepted agent identities survive upgrade retries without writes or native replay", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const statuses = ["queued", "running", "completed", "failed", "interrupted", "unknown"] as const;
  try {
    await fc.assert(fc.asyncProperty(fc.constantFrom(...statuses), fc.boolean(), fc.string({ maxLength: 32 }), fc.integer({ min: 1, max: 4 }), async (status, reopen, text, copies) => {
      await fixture(async ({ root, runtime, backend, store, profile, steers, starts, submit, value, terminal, envelope }: any) => {
        const request = value("legacy", `legacy-${text}`);
        // This unchanged acceptance path has the base version's delivery-less
        // fingerprint and FIFO semantics, before default agent delivery changed.
        const accepted = await submit({ ...request, delivery: "new_turn" });
        if (status !== "queued") {
          terminal(); await drain();
          if (status === "unknown") runtime.finish(accepted.queueEntryId, "unknown", "Native outcome uncertain");
          else if (status !== "running") terminal("turn-2", status);
          await drain();
        }
        expect(store.get(accepted.queueEntryId)).toMatchObject({ status });
        expect(store.get(accepted.queueEntryId).delivery).toBeUndefined();
        let owner = runtime, ownerStore = store, ownerBackend = backend;
        if (reopen) {
          runtime.turnQueue.close();
          const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
          ownerStore = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
          owner = new Runtime({ store: ownerStore, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
          owner.codex = { startTurn: () => { throw new Error("replayed legacy start"); }, steerTurn: () => { throw new Error("replayed legacy steer"); }, stop: async () => {} };
          ownerBackend = new HeadlessFederation({ directory: path.join(root, "headless"), runtime: owner, profile: "fixture", onFailure() {} }).backend;
        }
        try {
          const before = ownerStore.get(accepted.queueEntryId), queued = owner.turnQueue.getAllQueuedEntries();
          const sends = [starts.length, steers.length];
          const { writes } = await measureSqliteWrites(async () => {
            for (let i = 0; i < copies; i++) {
              const retry = ownerBackend.handle("backend.startTurn", request, envelope);
              if (before.turnId || before.status === "queued") expect((await retry).queueEntryId).toBe(before.id);
              else await expect(retry).rejects.toThrow(before.reason);
            }
            for (const changed of [
              { ...request, input: [{ type: "text", text: `${request.input[0].text}!` }] },
              { ...request, model: "different-model" },
              { ...request, messageOrigin: { ...request.messageOrigin, sourceThread: { ...request.messageOrigin.sourceThread, threadId: "different-sender" } } },
            ]) await expect(ownerBackend.handle("backend.startTurn", changed, envelope)).rejects.toThrow("different input");
          });
          expect(writes).toMatchObject({ commits: 0, statements: 0, rowsChanged: 0, walBytes: 0 });
          expect(ownerStore.get(before.id)).toEqual(before);
          expect(owner.turnQueue.getAllQueuedEntries()).toEqual(queued);
          expect([starts.length, steers.length]).toEqual(sends);
        } finally { if (reopen) await owner.stop(); }
      });
    }), { numRuns: 8, examples: statuses.flatMap(status => [false, true].map(reopen => [status, reopen, "", 2] as [typeof status, boolean, string, number])) });
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === "win32")("explicit new turns, all requested settings and FIFO predecessors prevent default agent steering", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("delivery", "model", "reasoningEffort", "serviceTier", "executionMode", "approvalPolicy", "sandbox", "fastMode"), async setting => {
    await fixture(async ({ runtime, store, steers, starts, submit, value, terminal }: any) => {
      const overrides: Record<string, unknown> = { delivery: "new_turn", model: "chosen", reasoningEffort: "high", serviceTier: "fast", executionMode: "default", approvalPolicy: "never", sandbox: "read-only", fastMode: false };
      const first = await submit({ ...value("ordinary"), [setting]: overrides[setting] });
      const second = await submit(value("guidance"));
      await drain();
      expect(steers).toEqual([]);
      expect(runtime.turnQueue.getQueuedEntries(ref).map((entry: any) => entry.id)).toEqual([first.queueEntryId, second.queueEntryId]);
      terminal(); await drain();
      expect(starts).toHaveLength(2);
      expect(steers).toHaveLength(1);
      expect(steers[0].expectedTurnId).toBe("turn-2");
      expect(store.get(second.queueEntryId).turnId).toBe("turn-2");
    });
  }), { numRuns: 16 });
});

it.skipIf(process.platform === "win32")("replacing an individual queued steer preserves its live FIFO position and accepts a new immutable identity", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 4 }), fc.integer({ min: 0, max: 3 }), async (count, position) => {
    await fixture(async ({ runtime, backend, store, steers, starts, submit, value, envelope }: any) => {
      const accepted: any[] = [], expected = Array.from({ length: count }, (_, index) => `message${index}`);
      const index = position % count;
      for (const text of expected) {
        const request = value(text), result = await submit(request);
        accepted.push({ request, id: result.queueEntryId, fingerprint: store.get(result.queueEntryId).fingerprint });
        await runtime.setQueuedTurnPaused({ queueEntryId: result.queueEntryId, paused: true });
      }
      const original = accepted[index];
      expected[index] = "replacement";
      const replacement = await backend.handle("backend.replaceQueuedMessage", { ...ref, queueEntryId: original.id,
        input: [{ type: "text", text: expected[index] }], messageOrigin: original.request.messageOrigin }, { ...envelope, id: "replacement" });
      expect(replacement.queueEntryId).not.toBe(original.id);
      expect(store.get(original.id)).toMatchObject({ fingerprint: original.fingerprint, status: "interrupted" });
      expect(store.get(replacement.queueEntryId)).toMatchObject({ status: "queued", delivery: "queued-steer" });
      expect(runtime.turnQueue.getQueuedEntries(ref).map((entry: any) => entry.input[0].text)).toEqual(expected);
      for (const { id, fingerprint } of accepted) expect(store.get(id).fingerprint).toBe(fingerprint);
      for (const entry of runtime.turnQueue.getQueuedEntries(ref)) await runtime.setQueuedTurnPaused({ queueEntryId: entry.id, paused: false });
      await drain();
      expect(steers.map((request: any) => request.input[0].text)).toEqual(expected);
      expect(starts).toHaveLength(1);
      expect(runtime.active).toBe("active");
    });
  }), { numRuns: 8, examples: [[2, 0]] });
});

it.skipIf(process.platform === "win32")("generated pause/order/cancel commands preserve individual input and dispatch the live FIFO", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.boolean(), async (count, cancel) => {
    await fixture(async ({ runtime, backend, store, steers, submit, value }: any) => {
      const accepted: any[] = [];
      await runtime.turnQueue.withDispatchSuspended(ref, async () => {
        for (let i = 0; i < count; i++) {
          const result = await submit(value(`message${i}`));
          accepted.push({ id: result.queueEntryId, job: store.get(result.queueEntryId) });
        }
      });
      // Controls reserve dispatch synchronously before the event-loop drain.
      await runtime.setQueuedTurnPaused({ queueEntryId: accepted[0].id, paused: true });
      await runtime.moveQueuedTurn({ queueEntryId: accepted.at(-1).id, beforeQueueEntryId: accepted[1].id });
      if (cancel) {
        const snapshot = runtime.readQueuedTurn({ ...ref, queueEntryId: accepted[1].id });
        expect(await runtime.cancelQueuedTurn({ queueEntryId: accepted[1].id, expectedContentHash: "stale" })).toMatchObject({ disposition: "content_changed" });
        expect(await runtime.cancelQueuedTurn({ queueEntryId: accepted[1].id, expectedContentHash: snapshot.contentHash })).toMatchObject({ disposition: "cancelled" });
      }
      const fifo = runtime.turnQueue.getQueuedEntries(ref).filter((entry: any) => !entry.paused).map((entry: any) => entry.id);
      const text = fifo.map((id: string) => runtime.readQueuedTurn({ ...ref, queueEntryId: id }).input[0].text);
      await drain();
      expect(steers.map((request: any) => request.input[0].text)).toEqual(text);
      expect(backend.queuedTurns(ref.threadId).map((entry: any) => entry.queueEntryId)).toEqual([accepted[0].id]);
      for (const { id, job } of accepted) expect(store.get(id).fingerprint).toBe(job.fingerprint);
      await runtime.setQueuedTurnPaused({ queueEntryId: accepted[0].id, paused: false });
      await drain();
      expect(steers.at(-1).input[0].text).toBe("message0");
      expect(runtime.active).toBe("active");
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("claimed steering owns global dispatch through late acknowledgement and cannot be cancelled or replayed", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("completed", "failed", "interrupted"), async status => {
    await fixture(async ({ runtime, backend, store, steers, starts, submit, value, terminal }: any) => {
      let entered!: () => void, release!: () => void;
      const native = new Promise<void>(resolve => { entered = resolve; });
      const acknowledgement = new Promise<void>(resolve => { release = resolve; });
      runtime.codex.steerTurn = async (request: any) => { steers.push(request); entered(); await acknowledgement; return { turnId: request.expectedTurnId }; };
      const request = value("guidance"), accepted = await submit(request);
      await native;
      const claimed = store.get(accepted.queueEntryId);
      let retried = false, waiting: any;
      const retry = submit(request).then(() => { retried = true; });
      try {
        const dispatch = runtime.dispatches.get(accepted.queueEntryId);
        expect(dispatch).toBeDefined();
        await drain();
        expect(retried).toBe(false);
        expect(claimed).toMatchObject({ status: "starting", turnId: "turn-1" });
        expect(await runtime.cancelQueuedTurn({ queueEntryId: accepted.queueEntryId })).toMatchObject({ disposition: "already_admitted" });
        waiting = await submit({ ...value("waiting"), delivery: "new_turn" });
        terminal("turn-1", status);
        await drain();
        expect(runtime.dispatches.get(accepted.queueEntryId)).toBe(dispatch);
        expect(retried).toBe(false);
        expect(starts).toHaveLength(1);
        expect(store.get(accepted.queueEntryId)).toMatchObject({ status, fingerprint: claimed.fingerprint, turnId: "turn-1" });
      } finally { release(); }
      await retry; await drain();
      expect(retried).toBe(true);
      expect(runtime.dispatches.has(accepted.queueEntryId)).toBe(false);
      expect(store.get(accepted.queueEntryId)).toMatchObject({ status, fingerprint: claimed.fingerprint, turnId: "turn-1" });
      if (status === "failed") expect(backend.queuedTurns(ref.threadId)[0]).toMatchObject({ queueEntryId: waiting.queueEntryId, manualReleaseRequired: true });
      else expect(starts).toHaveLength(2);
      await submit(request);
      expect(steers).toHaveLength(1);
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("live refusal holds unclaimed input while claimed native/finalization refusal stays uncertain without retry", async () => {
  for (const phase of ["lock", "claim", "native", "confirmation", "origin"]) {
    await fixture(async ({ runtime, backend, store, steers, submit, value }: any) => {
      const save = store.save.bind(store), request = value("guidance");
      let id: string;
      store.save = (job: any) => {
        if ((phase === "claim" && job.id === id && job.status === "starting")
          || (phase === "confirmation" && job.id === id && job.status === "running")
          || (phase === "origin" && job.id === "active" && job.messageOrigin)) throw new Error("storage refused");
        return save(job);
      };
      const native = runtime.codex.steerTurn;
      runtime.codex.steerTurn = async (params: any) => {
        if (phase === "native") { steers.push(params); throw new Error("native outcome uncertain"); }
        return native(params);
      };
      const accepted = await submit(request); id = accepted.queueEntryId;
      runtime.threadLocked = () => phase === "lock";
      await drain();
      const job = store.get(id), unclaimed = phase === "lock" || phase === "claim";
      expect(job.status).toBe(unclaimed ? "queued" : "unknown");
      expect(steers).toHaveLength(unclaimed ? 0 : 1);
      if (unclaimed) expect(backend.queuedTurns(ref.threadId)[0]).toMatchObject({ queueEntryId: id, manualReleaseRequired: true });
      else expect(runtime.turnQueue.getQueuedEntries(ref)).toEqual([]);
      runtime.threadLocked = () => false;
      store.save = save;
      for (let i = 0; i < 6; i++) { await submit(request); runtime.turnQueue.drainAll(); await drain(); }
      expect(steers).toHaveLength(unclaimed ? 0 : 1);
      expect(store.get(id).fingerprint).toBe(job.fingerprint);
      expect(runtime.active).toBe("active");
    });
  }
});

it.skipIf(process.platform === "win32")("a fresh owner settles accepted queued and steered jobs as unknown and never restores input", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async graceful => {
    await fixture(async ({ root, runtime, backend, store, profile, steers, submit, value }: any) => {
      const request = value("guidance"), steered = await submit(request); await drain();
      const waiting = await submit({ ...value("waiting"), delivery: "new_turn" });
      const prior = [steered, waiting].map(result => store.get(result.queueEntryId));
      if (graceful) await runtime.stop();
      else runtime.turnQueue.close();
      const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
      const reopened = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      const fresh = new Runtime({ store: reopened, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
      fresh.codex = { startTurn: () => { throw new Error("replayed start"); }, steerTurn: () => { throw new Error("replayed steer"); }, stop: async () => {} };
      const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime: fresh, profile: "fixture", onFailure() {} });
      try {
        for (const job of prior) expect(reopened.get(job.id)).toMatchObject({ status: "unknown", fingerprint: job.fingerprint });
        await federation.backend.handle("backend.startTurn", request, { sourceInstanceId: "issuer", id: "retry" });
        expect(fresh.turnQueue.getAllQueuedEntries()).toEqual([]);
        expect(steers).toHaveLength(1);
        expect(backend.owned(ref.threadId).id).toBe(ref.threadId);
      } finally { await fresh.stop(); }
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("an accepted interjection never becomes a second native interrupt owner", async () => {
  await fixture(async ({ runtime, backend, store, submit, value }: any) => {
    const accepted = await submit(value("guidance")); await drain();
    let interrupts = 0;
    runtime.codex.interruptTurn = async () => { interrupts++; return {}; };
    await expect(runtime.handle("interrupt", { id: accepted.queueEntryId })).rejects.toThrow("does not own");
    expect(interrupts).toBe(0);
    expect(store.get("active").status).toBe("running");
    expect(runtime.active).toBe("active");
    await backend.handle("backend.controlActiveTurn", { ...ref, operation: "stop", expectedTurnId: "turn-1", requestId: "owner-stop" });
    expect(interrupts).toBe(1);
    expect(store.get("active").status).toBe("interrupting");
  });
});

it.skipIf(process.platform === "win32")("a refused steering claim cannot restore waiting input behind shutdown's cancellation sweep", async () => {
  await fixture(async ({ runtime, store, steers, submit, value }: any) => {
    const request = value("claim-stop");
    const accepted = await submit(request), save = store.save.bind(store);
    let stopped: Promise<void> | undefined;
    runtime.onFailure = () => { stopped ??= runtime.stop(); };
    store.save = (job: any) => {
      if (job.id === accepted.queueEntryId && job.status === "starting") throw new Error("claim refused");
      return save(job);
    };
    await drain();
    await stopped;
    expect(runtime.stopping).toBe(true);
    expect(store.get(accepted.queueEntryId).status).toBe("unknown");
    expect(runtime.turnQueue.getAllQueuedEntries()).toEqual([]);
    expect(steers).toEqual([]);
  });
});

it.skipIf(process.platform === "win32")("explicit Retry of unclaimed held guidance reaches the live native owner exactly once", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("lock", "claim"), fc.integer({ min: 1, max: 4 }), async (refusal, copies) => {
    await fixture(async ({ runtime, backend, store, steers, starts, submit, value, terminal, events }: any) => {
      const request = value("retry-guidance", "Invented held guidance");
      const accepted = await submit(request), id = accepted.queueEntryId;
      const prior = store.get(id), save = store.save.bind(store);
      runtime.threadLocked = () => refusal === "lock";
      store.save = (job: any) => {
        if (refusal === "claim" && job.id === id && job.status === "starting") throw new Error("claim refused");
        return save(job);
      };
      await drain();
      expect(store.get(id)).toMatchObject({ status: "queued", fingerprint: prior.fingerprint });
      expect(store.get(id).turnId).toBeUndefined();
      expect(backend.queuedTurns(ref.threadId)[0]).toMatchObject({ queueEntryId: id, manualReleaseRequired: true });
      expect(steers).toEqual([]);
      runtime.threadLocked = () => false;
      store.save = save;
      // Repeating acceptance never releases a review hold. Only Retry does.
      for (let i = 0; i < copies; i++) await submit(request);
      await drain();
      expect(steers).toEqual([]);
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: id })).toMatchObject({ disposition: "started", turnId: "turn-1" });
      await drain();
      expect(steers.map((call: any) => ({ input: call.input, turnId: call.expectedTurnId }))).toMatchObject([{ input: request.input, turnId: "turn-1" }]);
      expect(starts).toHaveLength(1);
      expect(runtime.active).toBe("active");
      expect(backend.activeJob(ref).id).toBe("active");
      expect(store.get(id)).toMatchObject({ fingerprint: prior.fingerprint, status: "running", turnId: "turn-1", messageOrigin: prior.messageOrigin });
      expect(events.some((event: any) => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === id && event.params.status === "started")).toBe(true);
      for (let i = 0; i < copies; i++) {
        expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: id })).toMatchObject({ disposition: "not_found" });
        await submit(request);
      }
      terminal(); await drain();
      expect(store.get(id)).toMatchObject({ status: "completed", fingerprint: prior.fingerprint, turnId: "turn-1" });
      expect(steers).toHaveLength(1);
    });
  }), { numRuns: 8, examples: [["lock", 1], ["claim", 1]] });
});

it.skipIf(process.platform === "win32")("held guidance Retry preserves live refusals, pauses, order and immutable acceptance", async () => {
  const gates = ["lock", "intake", "creating", "uncertain", "dispatch", "stopping", "retired", "project", "interrupting"];
  for (const gate of gates) {
    await fixture(async ({ runtime, backend, store, steers, submit, value }: any) => {
      const accepted = await submit(value("gated-guidance")), id = accepted.queueEntryId;
      runtime.threadLocked = () => true; await drain();
      runtime.threadLocked = () => false;
      const job = store.get(id), before = backend.queueProjection({ protocol: 2, ref });
      const owns = runtime.ownsThread, cwd = runtime.threadCwd, dispatch = Promise.resolve();
      if (gate === "lock") runtime.threadLocked = () => true;
      if (gate === "intake") runtime.intakeBusy = true;
      if (gate === "creating") backend.creating = true;
      if (gate === "uncertain") runtime.uncertain = true;
      if (gate === "dispatch") runtime.dispatches.set("fixture-pending", dispatch);
      if (gate === "stopping") runtime.stopping = true;
      if (gate === "retired") runtime.ownsThread = () => false;
      if (gate === "project") runtime.threadCwd = () => path.join(runtime.workspace, "missing");
      if (gate === "interrupting") {
        runtime.codex.interruptTurn = async () => ({});
        await runtime.handle("interrupt", { id: "active" });
      }
      try {
        expect(["blocked", "busy"]).toContain((await backend.handle("backend.releaseQueuedTurn", { queueEntryId: id })).disposition);
        expect(backend.queueProjection({ protocol: 2, ref })).toEqual(before);
        expect(store.get(id)).toEqual(job);
        expect(steers).toEqual([]);
      } finally {
        runtime.threadLocked = () => false; runtime.intakeBusy = false; backend.creating = false;
        runtime.uncertain = false; runtime.stopping = false; runtime.dispatches.delete("fixture-pending");
        runtime.ownsThread = owns; runtime.threadCwd = cwd;
      }
    });
  }
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), fc.boolean(), async (count, cancel) => {
    await fixture(async ({ runtime, backend, store, steers, submit, value }: any) => {
      const accepted = [];
      for (let i = 0; i < count; i++) accepted.push(await submit(value(`held-${i}`)));
      const paused = accepted[0].queueEntryId, next = accepted.at(-1).queueEntryId;
      const fingerprints = accepted.map(result => store.get(result.queueEntryId).fingerprint);
      const pause = await runtime.setQueuedTurnPaused({ queueEntryId: paused, paused: true });
      await runtime.moveQueuedTurn({ queueEntryId: next, beforeQueueEntryId: accepted[1].queueEntryId });
      runtime.threadLocked = () => true; await drain(); runtime.threadLocked = () => false;
      expect(await runtime.releaseQueuedTurn({ queueEntryId: paused })).toMatchObject({ disposition: "not_head" });
      if (cancel && count > 2) await runtime.cancelQueuedTurn({ queueEntryId: accepted[1].queueEntryId });
      const fifo = runtime.turnQueue.getQueuedEntries(ref).filter((entry: any) => !entry.paused).map((entry: any) => entry.input[0].text);
      expect(await runtime.releaseQueuedTurn({ queueEntryId: next })).toMatchObject({ disposition: "started", turnId: "turn-1" });
      await drain();
      expect(steers.map((call: any) => call.input[0].text)).toEqual(fifo);
      expect(backend.queuedTurns(ref.threadId)).toMatchObject([{ queueEntryId: paused, paused: true, pauseRevision: pause.pauseRevision }]);
      expect(accepted.map(result => store.get(result.queueEntryId).fingerprint)).toEqual(fingerprints);
      await runtime.setQueuedTurnPaused({ queueEntryId: paused, paused: false }); await drain();
      expect(steers.at(-1).input[0].text).toBe("held-0");
      expect(runtime.active).toBe("active");
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("retried guidance retains claim ownership through concurrent controls, new holds and late terminals", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("completed", "failed", "interrupted", "stop"), async status => {
    await fixture(async ({ runtime, backend, store, steers, starts, submit, value, terminal }: any) => {
      const request = value("held-guidance"), accepted = await submit(request), id = accepted.queueEntryId;
      runtime.threadLocked = () => true; await drain(); runtime.threadLocked = () => false;
      let entered!: () => void, acknowledge!: () => void;
      const native = new Promise<void>(resolve => { entered = resolve; });
      const ack = new Promise<void>(resolve => { acknowledge = resolve; });
      runtime.codex.steerTurn = async (call: any) => { steers.push(call); entered(); await ack; return { turnId: call.expectedTurnId }; };
      const retry = runtime.releaseQueuedTurn({ queueEntryId: id });
      await native;
      try {
        expect(store.get(id)).toMatchObject({ status: "starting", turnId: "turn-1" });
        expect(await runtime.releaseQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "not_found" });
        expect(await runtime.cancelQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "already_admitted", cancelled: false });
        expect(await runtime.setQueuedTurnPaused({ queueEntryId: id, paused: true })).toMatchObject({ disposition: "not_found" });
        expect(await runtime.moveQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "not_found" });
        const reservation = runtime.dispatches.get(id);
        expect(reservation).toBeDefined();
        let retried = false;
        const duplicate = submit(request).then((result: any) => { retried = true; return result; });
        await drain();
        expect(retried).toBe(false);
        const waiting = runtime.submit({ id: "late-review", threadId: ref.threadId, prompt: "Invented new review hold" },
          { delivery: "queued-steer", manualReleaseRequired: true, holdReason: "Independent later review" });
        expect(runtime.active).toBe("active");
        let stopped: Promise<void> | undefined;
        if (status === "stop") stopped = runtime.stop();
        else terminal("turn-1", status);
        expect(starts).toHaveLength(1);
        await drain();
        expect(runtime.dispatches.get(id)).toBe(reservation);
        expect(retried).toBe(false);
        acknowledge();
        await retry; await duplicate; await stopped; await drain();
        expect(retried).toBe(true);
        expect(runtime.dispatches.has(id)).toBe(false);
        expect(store.get(id)).toMatchObject({ status: status === "stop" ? "unknown" : status, turnId: "turn-1" });
        expect(steers).toHaveLength(1);
        expect(starts).toHaveLength(1);
        if (status === "stop") expect(store.get(waiting.id).status).toBe("unknown");
        else expect(backend.queuedTurns(ref.threadId)[0]).toMatchObject({ queueEntryId: waiting.id, manualReleaseRequired: true });
        expect(await runtime.releaseQueuedTurn({ queueEntryId: id })).toMatchObject({ disposition: "not_found" });
      } finally { acknowledge(); await retry; }
    });
  }), { numRuns: 8, examples: [["completed"], ["stop"]] });
});

it.skipIf(process.platform === "win32")("budgets explicit held guidance Retry without reacceptance or replay writes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const budgetFile = "outpost-held-steer-retry-write-budgets.json";
  const measure = async (scenario: string, note: string, work: () => Promise<void>) => {
    const { writes } = await measureSqliteWrites(work);
    expectSqliteWriteBudget({ budgetFile, scenario, note, writes });
  };
  try {
    for (const phase of ["accepted", "claim-refused", "native-uncertain", "confirmation-uncertain"]) {
      await fixture(async ({ runtime, store, submit, value, steers }: any) => {
        const request = value("retry-budget"), accepted = await submit(request), id = accepted.queueEntryId;
        runtime.threadLocked = () => true; await drain(); runtime.threadLocked = () => false;
        const before = store.get(id), save = store.save.bind(store);
        if (phase === "native-uncertain") runtime.codex.steerTurn = async (call: any) => { steers.push(call); throw new Error("uncertain"); };
        store.save = (job: any) => {
          if (job.id === id && ((phase === "claim-refused" && job.status === "starting")
            || (phase === "confirmation-uncertain" && job.status === "running"))) throw new Error("refused");
          return save(job);
        };
        await measure(phase, "One explicit Retry of an already accepted unclaimed held steer; setup and original acceptance excluded", async () => {
          const result = await runtime.releaseQueuedTurn({ queueEntryId: id });
          expect(result.disposition).toBe(phase === "claim-refused" ? "blocked" : "started");
          await drain();
        });
        expect(store.get(id).fingerprint).toBe(before.fingerprint);
        const sends = steers.length;
        await measure(`${phase}-100-retries`, "One hundred repeated acceptances, explicit retries and reads; no extra native send", async () => {
          for (let i = 0; i < 100; i++) {
            await submit(request); await runtime.releaseQueuedTurn({ queueEntryId: id });
            runtime.turnQueue.getAllQueuedEntries();
          }
        });
        expect(steers).toHaveLength(sends);
        store.save = save;
        if (phase === "accepted") await measure("stop-after-retry", "Shutdown settles original and retried guidance without replay", async () => { await runtime.stop(); });
      });
    }
    await fixture(async ({ runtime, submit, value }: any) => {
      const accepted = await submit(value("gated-budget"));
      runtime.threadLocked = () => true; await drain(); runtime.threadLocked = () => false;
      runtime.intakeBusy = true;
      try {
        await measure("gated-100-retries", "One hundred live-gated retries preserve the hold and make no writes", async () => {
          for (let i = 0; i < 100; i++) expect(await runtime.releaseQueuedTurn({ queueEntryId: accepted.queueEntryId })).toMatchObject({ disposition: "busy" });
        });
      } finally { runtime.intakeBusy = false; }
    });
  } finally { vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === "win32")("budgets individual queued steering at acceptance, target claim, terminal and recovery boundaries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T18:00:00Z"));
  const budgetFile = "outpost-queued-steer-write-budgets.json";
  const measure = async (scenario: string, note: string, work: () => Promise<void>) => {
    const { writes } = await measureSqliteWrites(work);
    expectSqliteWriteBudget({ budgetFile, scenario, note, writes });
  };
  try {
    for (const phase of ["accepted", "native-uncertain", "confirmation-uncertain"]) {
      await fixture(async ({ runtime, store, steers, submit, value, terminal }: any) => {
        const request = value("guidance"), save = store.save.bind(store);
        if (phase === "native-uncertain") runtime.codex.steerTurn = async (params: any) => { steers.push(params); throw new Error("uncertain"); };
        if (phase === "confirmation-uncertain") store.save = (job: any) => {
          if (job.id !== "active" && job.status === "running") throw new Error("refused confirmation");
          return save(job);
        };
        let accepted: any;
        await measure(phase, "One actual authenticated agent admission, native target claim and accepted/uncertain outcome, excluding active-turn setup", async () => { accepted = await submit(request); await drain(); });
        const count = steers.length;
        await measure(`${phase}-100-retries`, "One hundred identical actual startTurn retries and queue reads; no native resend", async () => {
          for (let i = 0; i < 100; i++) { await submit(request); runtime.turnQueue.getAllQueuedEntries(); }
        });
        expect(steers).toHaveLength(count);
        store.save = save;
        if (phase === "accepted") {
          await measure("non-owner-interrupt-100", "One hundred attempts to interrupt through an interjection identity; no native control or writes", async () => {
            for (let i = 0; i < 100; i++) await expect(runtime.handle("interrupt", { id: accepted.queueEntryId })).rejects.toThrow("does not own");
          });
          await measure("native-terminal", "One provider terminal settles the original owner and one accepted interjection", async () => { terminal(); await drain(); });
        }
      });
    }
    await fixture(async ({ runtime, submit, value }: any) => {
      await submit(value("guidance")); await drain();
      await submit({ ...value("waiting"), delivery: "new_turn" });
      await measure("graceful-stop", "Stop one original owner, one accepted interjection and one waiting new turn without replay", async () => { await runtime.stop(); });
    });
    await fixture(async ({ root, runtime, profile, submit, value }: any) => {
      await submit(value("guidance")); await drain();
      await submit({ ...value("waiting"), delivery: "new_turn" });
      runtime.turnQueue.close();
      const { JobStore } = await load("store.js");
      await measure("recover", "The existing recovery transaction settles original, steered and waiting jobs without replay", async () => {
        new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
      });
    });
    await fixture(async ({ runtime, store, submit, value }: any) => {
      const accepted = await submit(value("claim-stop")), save = store.save.bind(store);
      let stopped: Promise<void> | undefined;
      runtime.onFailure = () => { stopped ??= runtime.stop(); };
      store.save = (job: any) => {
        if (job.id === accepted.queueEntryId && job.status === "starting") throw new Error("claim refused");
        return save(job);
      };
      await measure("refused-claim-stop", "A refused claim shuts down the owner and retires input restored after the first cancellation sweep", async () => {
        await drain(); await stopped;
      });
      expect(store.get(accepted.queueEntryId).status).toBe("unknown");
      expect(runtime.turnQueue.getAllQueuedEntries()).toEqual([]);
    });
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
