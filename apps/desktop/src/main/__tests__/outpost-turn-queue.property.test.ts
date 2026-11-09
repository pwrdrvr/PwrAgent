import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent", file)).href);
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

// The executable Runtime's private-directory contract supports Linux/macOS.
async function fixture(work: (runtime: any, backend: any, store: any, profile: any, events: any[]) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessBackend }] = await Promise.all([load("src/store.js"), load("src/runtime.js"), load("src/federation-backend.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-queue-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const events: any[] = [];
    const backend = new HeadlessBackend(runtime, (event: any) => events.push(event.notification));
    runtime.onEvent = (event: unknown) => backend.event(event);
    backend.persistCreatedNativeThread({ id: "native", title: "Existing", titleSource: "explicit", cwd: root });
    await work(runtime, backend, store, profile, events);
  } finally {
    if (runtime) { runtime.codex.stop = async () => {}; await runtime.stop(); }
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("actual Outpost durable admissions follow the shared FIFO and provider terminals without replay", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), fc.integer({ min: 0, max: 3 }), async (waiting, duplicates) => {
    await fixture(async (runtime, backend, store, _profile, events) => {
      const sent: string[] = [];
      runtime.codex = { startTurn: async (params: any) => {
        const prompt = params.input[0].text;
        expect(store.get(prompt).status).toBe("starting");
        sent.push(prompt);
        return { threadId: "native", turnId: `turn-${prompt}` };
      }, stop: async () => {} };
      const input = (i: number) => ({ id: `job${i}`, threadId: "native", prompt: `job${i}` });
      const accepted = runtime.submit(input(0));
      await runtime.work;
      const fingerprints = [accepted.fingerprint];
      for (let i = 1; i <= waiting; i++) {
        const queued = runtime.submit(input(i));
        expect(queued.status).toBe("queued");
        fingerprints.push(queued.fingerprint);
        for (let repeat = 0; repeat < duplicates; repeat++) expect(runtime.submit(input(i))).toEqual(store.get(`job${i}`));
      }
      const projection = await backend.handle("getNavigationQueueProjection", { protocol: 2, ref: { backend: "codex", threadId: "native" } });
      expect(projection.entries.map((entry: any) => entry.queueEntryId)).toEqual(Array.from({ length: waiting }, (_, i) => `job${i + 1}`));
      expect(sent).toEqual(["job0"]);
      for (let i = 0; i <= waiting; i++) {
        expect(runtime.active).toBe(`job${i}`);
        const terminal = { method: "turn/completed", params: { threadId: "native", turn: { id: `turn-job${i}`, status: "completed" } } };
        runtime.notification(terminal);
        for (let repeat = 0; repeat < duplicates; repeat++) runtime.notification(terminal);
        for (let n = 0; n < 12; n++) await tick();
        expect(store.get(`job${i}`)).toMatchObject({ fingerprint: fingerprints[i], status: "completed", threadId: "native", turnId: `turn-job${i}` });
        expect(JSON.stringify(store.get(`job${i}`))).not.toContain('"prompt"');
      }
      expect(sent).toEqual(Array.from({ length: waiting + 1 }, (_, i) => `job${i}`));
      expect(events.some(event => event.method === "thread/turnQueue/updated" && event.params.status === "queued")).toBe(true);
      expect(runtime.active).toBeNull();
      const { ThreadTurnQueue } = await load("dist/federation-core.js");
      expect(Object.getPrototypeOf(runtime.turnQueue)).toBe(ThreadTurnQueue.prototype);
    });
  }), { numRuns: 12 });
});

it.skipIf(process.platform === "win32")("provider occupancy, early duplicate terminals and queued cancellation agree with the actual host", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (early, cancel, sameThread) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      backend.persistCreatedNativeThread({ id: "other", title: "Other", titleSource: "explicit", cwd: runtime.workspace });
      runtime.codex = { startTurn: async ({ threadId }: any) => {
        sends++;
        const terminal = { method: "turn/completed", params: { threadId, turn: { id: `turn${sends}`, status: "completed" } } };
        if (early && sends > 1) { runtime.notification(terminal); runtime.notification(terminal); }
        return { threadId, turnId: `turn${sends}` };
      }, stop: async () => {} };
      runtime.submit({ id: "first", prompt: "first", threadId: "native" });
      await runtime.work;
      const request = { backend: "codex", threadId: sameThread ? "native" : "other", input: [{ type: "text", text: "waiting" }], queueEntryId: "request" };
      const result = await backend.startTurn(request, { id: "envelope", sourceInstanceId: "authenticated" });
      expect(result).toMatchObject({ queueStatus: "queued" });
      expect(sends).toBe(1);
      expect(backend.activeJob({ threadId: "native" }).id).toBe("first");
      if (cancel) {
        expect(await runtime.handle("interrupt", { id: result.queueEntryId })).toMatchObject({ status: "interrupted" });
        expect(store.get(result.queueEntryId)).not.toHaveProperty("turnId");
        expect(backend.activeJob({ threadId: "native" }).id).toBe("first");
      }
      runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn1", status: "completed" } } });
      for (let n = 0; n < 12; n++) await tick();
      expect(sends).toBe(cancel ? 1 : 2);
      expect(store.get(result.queueEntryId).status).toBe(cancel ? "interrupted" : early ? "completed" : "running");
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("queue pages and revision fences agree with the live shared FIFO for generated admissions", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 101, max: 110 }), fc.constantFrom("x", "😀"), async (count, character) => {
    await fixture(async (runtime, backend) => {
      runtime.codex = { startTurn: async () => ({ threadId: "native", turnId: "active" }), stop: async () => {} };
      runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
      for (let i = 0; i < count; i++) runtime.submit({ id: `page${i}`, threadId: "native", prompt: character.repeat(250) });
      const request = { protocol: 2, ref: { backend: "codex", threadId: "native" } };
      const first = backend.queueProjection(request);
      expect(first.entries).toHaveLength(100);
      expect(first.complete).toBe(false);
      const second = backend.queueProjection({ ...request, cursor: first.nextCursor });
      expect(second.complete).toBe(true);
      expect([...first.entries, ...second.entries].map(entry => entry.queueEntryId)).toEqual(runtime.turnQueue.getQueuedEntries(request.ref).map((entry: { id: string }) => entry.id));
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(256 * 1024);
      await runtime.handle("interrupt", { id: "page0" });
      expect(() => backend.queueProjection({ ...request, cursor: first.nextCursor })).toThrow("navigation_cursor_expired");
      expect(() => backend.queueProjection({ ...request, cursor: "malformed" })).toThrow("navigation_invalid_request");
    });
  }), { numRuns: 3 });
});

it.skipIf(process.platform === "win32")("queued durable acceptance survives shutdown or crash recovery without persisting or replaying input", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 3 }), async (graceful, count) => {
    await fixture(async (runtime, backend, store, profile) => {
      let sends = 0;
      runtime.codex = { startTurn: async () => { sends++; return { threadId: "native", turnId: "active" }; }, stop: async () => {} };
      runtime.submit({ id: "first", prompt: "private-first", threadId: "native" });
      await runtime.work;
      const inputs = Array.from({ length: count }, (_, i) => ({ id: `waiting${i}`, prompt: `private-waiting${i}`, threadId: "native" }));
      const fingerprints = inputs.map(input => runtime.submit(input).fingerprint);
      if (graceful) await runtime.stop();
      else runtime.turnQueue.close();
      const { JobStore } = await load("src/store.js");
      const recovered = new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
      runtime.stopping = false;
      runtime.store = recovered;
      for (let i = 0; i < inputs.length; i++) {
        expect(runtime.submit(inputs[i])).toMatchObject({ fingerprint: fingerprints[i], status: "unknown", threadId: "native" });
        expect(JSON.stringify(recovered.get(inputs[i]!.id))).not.toContain("private-");
      }
      expect(recovered.get("first")).toMatchObject({ status: "unknown", turnId: "active" });
      expect(sends).toBe(1);
      expect(backend.owned("native").id).toBe("native");
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("shutdown from an acceptance observer cannot strand or reject the durably accepted job", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async continued => {
    await fixture(async (runtime, _backend, store) => {
      let sends = 0;
      runtime.codex = { startThread: async () => ({ threadId: "created" }), startTurn: async () => { sends++; return { threadId: "native", turnId: "turn" }; }, stop: async () => {} };
      let stop: Promise<void> | undefined;
      runtime.onEvent = (event: any) => {
        if (event.method === "headless/jobChanged" && event.params.id === "accepted" && event.params.status === "starting") stop ??= runtime.stop();
      };
      const job = runtime.submit({ id: "accepted", prompt: "private", ...(continued ? { threadId: "native" } : {}) });
      await stop;
      expect(store.get(job.id)).toMatchObject({ status: "unknown", fingerprint: job.fingerprint });
      expect(sends).toBe(0);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("native refusal holds queued input, and confirmed acceptance never becomes a retry after storage refusal", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("native", "confirmation", "lock"), async refusal => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.codex = { startTurn: async () => {
        sends++;
        if (sends === 2 && refusal === "native") throw new Error("Native refusal");
        return { threadId: "native", turnId: `turn${sends}` };
      }, stop: async () => {} };
      runtime.submit({ id: "first", prompt: "first", threadId: "native" });
      await runtime.work;
      const input = { id: "waiting", prompt: "waiting", threadId: "native" };
      runtime.submit(input);
      const save = store.save.bind(store);
      store.save = (job: any) => {
        if (refusal === "confirmation" && job.id === "waiting" && job.status === "running") throw new Error("Confirmation refused");
        return save(job);
      };
      runtime.threadLocked = () => refusal === "lock";
      runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn1", status: "completed" } } });
      for (let n = 0; n < 12; n++) await tick();
      const result = store.get("waiting");
      expect(result.status).toBe(refusal === "confirmation" ? "unknown" : "queued");
      if (refusal === "confirmation") expect(result.turnId).toBe("turn2");
      else expect(backend.queuedTurns("native")[0]).toMatchObject({ queueEntryId: "waiting", manualReleaseRequired: true });
      runtime.threadLocked = () => false;
      for (let i = 0; i < 3; i++) { runtime.submit(input); runtime.turnQueue.drainAll(); await tick(); }
      expect(sends).toBe(refusal === "lock" ? 1 : 2);
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("budgets actual queued acceptance, dispatch, cancellation and no-replay recovery boundaries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T14:00:00Z"));
  const budgetFile = "outpost-turn-queue-write-budgets.json";
  try {
    await fixture(async (runtime, backend, store, profile) => {
      let sends = 0;
      runtime.codex = { startTurn: async () => ({ threadId: "native", turnId: `turn${++sends}` }), stop: async () => {} };
      const record = async (scenario: string, note: string, work: () => unknown) => {
        const { writes } = await measureSqliteWrites(work);
        expectSqliteWriteBudget({ budgetFile, scenario, note, writes });
      };
      runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
      const input = { id: "waiting", threadId: "native", prompt: "waiting" };
      await record("queued-acceptance", "One continued-thread acceptance behind an active provider job; prompt remains transient", () => runtime.submit(input));
      await record("duplicate-projection", "1000 matching queued retries and live queue projections; no sends or writes", async () => {
        for (let i = 0; i < 1000; i++) { runtime.submit(input); await backend.queueProjection({ protocol: 2, ref: { backend: "codex", threadId: "native" } }); }
      });
      await record("queued-dispatch-terminal", "Prior terminal plus one queued dispatch/identity/confirmation/terminal; existing thread already explicitly named", async () => {
        runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn1", status: "completed" } } });
        for (let n = 0; n < 12; n++) await tick();
        runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn2", status: "completed" } } });
      });
      runtime.submit({ id: "active3", threadId: "native", prompt: "active3" }); await runtime.work;
      runtime.submit({ id: "cancel", threadId: "native", prompt: "cancel" });
      await record("queued-cancellation", "One queued job cancelled before provider admission", () => runtime.handle("interrupt", { id: "cancel" }));
      runtime.submit({ id: "lost", threadId: "native", prompt: "lost" });
      runtime.turnQueue.close();
      await record("queued-crash-recovery", "One recovery transaction settles both the active and queued jobs as unknown, with no input replay", async () => {
        const { JobStore } = await load("src/store.js");
        new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
      });
      expect(store.get("lost").status).toBe("unknown");
      expect(sends).toBe(3);
    });
    for (const refusal of ["native", "confirmation", "lock"] as const) {
      await fixture(async (runtime, _backend, store) => {
        let sends = 0;
        runtime.codex = { startTurn: async () => {
          if (++sends === 2 && refusal === "native") throw new Error("Native refused");
          return { threadId: "native", turnId: `turn${sends}` };
        }, stop: async () => {} };
        runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
        runtime.submit({ id: "waiting", threadId: "native", prompt: "waiting" });
        runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: "turn1", status: "completed" } } });
        runtime.threadLocked = () => refusal === "lock";
        const save = store.save.bind(store);
        store.save = (job: any) => {
          if (refusal === "confirmation" && job.id === "waiting" && job.status === "running") throw new Error("Confirmation refused");
          return save(job);
        };
        const { writes } = await measureSqliteWrites(async () => { for (let n = 0; n < 12; n++) await tick(); });
        expectSqliteWriteBudget({ budgetFile, scenario: `queued-${refusal}-refusal`, note: "Queued dispatch only, after acceptance/prior terminal; lock blocks before writes, native refusal holds, confirmation refusal preserves accepted IDs as unknown", writes });
      });
    }
    await fixture(async (runtime) => {
      runtime.codex = { startTurn: async () => ({ threadId: "native", turnId: "active" }), stop: async () => {} };
      runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
      runtime.submit({ id: "waiting", threadId: "native", prompt: "waiting" });
      const { writes } = await measureSqliteWrites(() => runtime.stop());
      expectSqliteWriteBudget({ budgetFile, scenario: "queued-shutdown", note: "Graceful shutdown settles one active and one queued job without replay; setup and acceptance excluded", writes });
    });
    await fixture(async (runtime) => {
      runtime.codex = { stop: async () => {} };
      let stop: Promise<void> | undefined;
      runtime.onEvent = (event: any) => { if (event.method === "headless/jobChanged" && event.params.status === "starting") stop ??= runtime.stop(); };
      const { writes } = await measureSqliteWrites(async () => { runtime.submit({ id: "accepted", threadId: "native", prompt: "private" }); await stop; });
      expectSqliteWriteBudget({ budgetFile, scenario: "acceptance-observer-shutdown", note: "Durable acceptance and unknown outcome when its observer immediately stops the host; zero provider sends", writes });
    });
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
