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
      expect(claimed).toMatchObject({ status: "starting", turnId: "turn-1" });
      expect(await runtime.cancelQueuedTurn({ queueEntryId: accepted.queueEntryId })).toMatchObject({ disposition: "already_admitted" });
      const waiting = await submit({ ...value("waiting"), delivery: "new_turn" });
      terminal("turn-1", status);
      await drain();
      expect(starts).toHaveLength(1);
      expect(store.get(accepted.queueEntryId)).toMatchObject({ status, fingerprint: claimed.fingerprint, turnId: "turn-1" });
      release(); await drain();
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
        await measure(phase, "One actual authenticated agent admission, native target claim and accepted/uncertain outcome, excluding active-turn setup", async () => { await submit(request); await drain(); });
        const count = steers.length;
        await measure(`${phase}-100-retries`, "One hundred identical actual startTurn retries and queue reads; no native resend", async () => {
          for (let i = 0; i < 100; i++) { await submit(request); runtime.turnQueue.getAllQueuedEntries(); }
        });
        expect(steers).toHaveLength(count);
        store.save = save;
        if (phase === "accepted") await measure("native-terminal", "One provider terminal settles the original owner and one accepted interjection", async () => { terminal(); await drain(); });
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
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
