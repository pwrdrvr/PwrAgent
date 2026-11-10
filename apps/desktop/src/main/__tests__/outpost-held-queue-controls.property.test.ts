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

const settle = async () => { for (let n = 0; n < 12; n++) await tick(); };
const terminal = (runtime: any, turnId: string, status = "completed") => runtime.notification({ method: "turn/completed", params: { threadId: "native", turn: { id: turnId, status } } });

async function held(runtime: any, count = 1) {
  let attempts = 0;
  const sent: string[] = [];
  runtime.codex = { startTurn: async ({ input }: any) => {
    attempts++;
    if (attempts === 2) throw new Error("Native refusal");
    sent.push(input[0].text);
    return { threadId: "native", turnId: `turn${attempts}` };
  }, stop: async () => {} };
  runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
  for (let i = 0; i < count; i++) runtime.submit({ id: `waiting${i}`, threadId: "native", prompt: `waiting${i}` });
  terminal(runtime, "turn1"); await settle();
  return sent;
}

it.skipIf(process.platform === "win32")("actual owner release reuses held durable identities and cancellations consume shared dispositions", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }), fc.integer({ min: 1, max: 3 }), async (cancel, duplicates) => {
    await fixture(async (runtime, backend, store, _profile, events) => {
      const sent = await held(runtime, cancel.length);
      const accepted = cancel.map((_, i) => store.get(`waiting${i}`));
      const { METHOD_CAPABILITIES } = await load("src/federation-backend.js");
      expect(METHOD_CAPABILITIES["backend.releaseQueuedTurn"]).toBe("turn_control");
      expect(METHOD_CAPABILITIES["backend.cancelQueuedTurn"]).toBe("turn_control");
      for (let i = 0; i < cancel.length; i++) {
        const queueEntryId = `waiting${i}`;
        const method = cancel[i] ? "backend.cancelQueuedTurn" : "backend.releaseQueuedTurn";
        // A prior retry may have released this FIFO; a failed provider turn
        // puts its successors back under the existing shared review hold.
        const response = await backend.handle(method, { queueEntryId });
        expect(response).toMatchObject({ queueEntryId, disposition: cancel[i] ? "cancelled" : "started" });
        if (!cancel[i]) {
          expect(store.get(queueEntryId)).toMatchObject({ status: "running", fingerprint: accepted[i].fingerprint });
          terminal(runtime, response.turnId, "failed"); await settle();
        }
        for (let repeat = 0; repeat < duplicates; repeat++) {
          expect((await backend.handle("backend.releaseQueuedTurn", { queueEntryId })).disposition).toBe("not_found");
          expect((await backend.handle("backend.cancelQueuedTurn", { queueEntryId })).cancelled).toBe(false);
          expect(runtime.submit({ id: queueEntryId, threadId: "native", prompt: queueEntryId }).fingerprint).toBe(accepted[i].fingerprint);
        }
        expect(store.get(queueEntryId)).toMatchObject({ fingerprint: accepted[i].fingerprint, status: cancel[i] ? "interrupted" : "failed" });
      }
      expect(sent).toEqual(["first", ...cancel.flatMap((value, i) => value ? [] : [`waiting${i}`])]);
      expect(backend.queuedTurns("native")).toEqual([]);
      expect(events.some(event => event.method === "thread/turnQueue/updated" && event.params.status === "cancelled")).toBe(cancel.some(Boolean));
    });
  }), { numRuns: 12 });
});

it.skipIf(process.platform === "win32")("owner retry rechecks live gates without erasing holds or changing acceptance", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("lock", "intake", "creating", "uncertain", "active", "retired", "project"), async gate => {
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime, 2);
      const before = backend.queueProjection({ protocol: 2, ref: { backend: "codex", threadId: "native" } });
      const job = store.get("waiting0");
      const priorOwns = runtime.ownsThread, priorCwd = runtime.threadCwd;
      if (gate === "lock") runtime.threadLocked = () => true;
      if (gate === "intake") runtime.intakeBusy = true;
      if (gate === "creating") backend.creating = true;
      if (gate === "uncertain") runtime.uncertain = true;
      if (gate === "active") runtime.active = "first";
      if (gate === "retired") runtime.ownsThread = () => false;
      if (gate === "project") runtime.threadCwd = () => path.join(runtime.workspace, "changed");
      const response = await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
      expect(["blocked", "busy"]).toContain(response.disposition);
      expect(backend.queueProjection({ protocol: 2, ref: { backend: "codex", threadId: "native" } })).toEqual(before);
      expect(store.get("waiting0")).toEqual(job);
      expect(sent).toEqual(["first"]);
      runtime.threadLocked = () => false; runtime.intakeBusy = false; backend.creating = false;
      runtime.uncertain = false; runtime.active = null; runtime.ownsThread = priorOwns; runtime.threadCwd = priorCwd;
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting1" })).toMatchObject({ disposition: "not_head" });
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "started" });
    });
  }), { numRuns: 14 });
});

it.skipIf(process.platform === "win32")("cancellation storage refusal keeps the waiting entry and accepted work is never cancelled or replayed", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async confirmationRefusal => {
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime);
      const save = store.save.bind(store);
      store.save = (job: any) => {
        if (job.id === "waiting0" && job.status === (confirmationRefusal ? "running" : "interrupted")) throw new Error("Storage refused");
        return save(job);
      };
      if (!confirmationRefusal) {
        await expect(backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0" })).rejects.toThrow("Storage refused");
        expect(store.get("waiting0").status).toBe("queued");
        expect(backend.queuedTurns("native")).toHaveLength(1);
        expect(sent).toEqual(["first"]);
        store.save = save;
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "cancelled", cancelled: true });
      } else {
        const result = await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
        expect(result.disposition).toBe("started");
        expect(store.get("waiting0")).toMatchObject({ status: "unknown", turnId: result.turnId });
        expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "already_admitted", cancelled: false, turnId: result.turnId });
        expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "not_found" });
        expect(sent).toEqual(["first", "waiting0"]);
      }
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("concurrent retries, terminal-before-confirmation and cancellation agree with provider admission", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(), async (early, cancelFirst) => {
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime);
      let confirm!: () => void;
      runtime.codex.startTurn = async () => {
        sent.push("waiting0");
        if (early) terminal(runtime, "confirmed");
        await new Promise<void>(resolve => { confirm = resolve; });
        return { threadId: "native", turnId: "confirmed" };
      };
      const request = { queueEntryId: "waiting0" };
      if (cancelFirst) {
        expect((await backend.handle("backend.cancelQueuedTurn", request)).disposition).toBe("cancelled");
        expect((await backend.handle("backend.releaseQueuedTurn", request)).disposition).toBe("not_found");
        expect(sent).toEqual(["first"]);
      } else {
        const release = backend.handle("backend.releaseQueuedTurn", request);
        while (!confirm) await tick();
        expect((await backend.handle("backend.cancelQueuedTurn", request))).toMatchObject({ disposition: "already_admitted", cancelled: false });
        expect((await backend.handle("backend.releaseQueuedTurn", request)).disposition).toBe("not_found");
        confirm();
        expect(await release).toMatchObject({ disposition: "started", turnId: "confirmed" });
        expect(store.get("waiting0").status).toBe(early ? "completed" : "running");
        expect(sent).toEqual(["first", "waiting0"]);
      }
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("queue control write budgets measure release, cancellation, blocked gates and duplicate outcomes", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T15:00:00Z"));
  const budgetFile = "outpost-held-queue-control-write-budgets.json";
  try {
    for (const cancel of [false, true]) await fixture(async (runtime, backend, store) => {
      await held(runtime);
      const request = { queueEntryId: "waiting0" };
      const { writes } = await measureSqliteWrites(() => backend.handle(cancel ? "backend.cancelQueuedTurn" : "backend.releaseQueuedTurn", request));
      expectSqliteWriteBudget({ budgetFile, scenario: cancel ? "held-cancellation" : "held-release",
        note: cancel ? "One held job's durable cancellation before shared FIFO removal; no provider send" : "One explicit held retry through existing dispatch/identity/confirmation boundaries; acceptance and terminal excluded", writes });
      const repeats = await measureSqliteWrites(async () => {
        for (let i = 0; i < 1000; i++) {
          await backend.handle("backend.releaseQueuedTurn", request);
          await backend.handle("backend.cancelQueuedTurn", request);
          backend.queueProjection({ protocol: 2, ref: { backend: "codex", threadId: "native" } });
        }
      });
      expectSqliteWriteBudget({ budgetFile, scenario: cancel ? "cancelled-retries" : "admitted-retries", note: "1000 repeated release/cancel/projection reads; no provider sends or writes", writes: repeats.writes });
      expect(store.get("waiting0").status).toBe(cancel ? "interrupted" : "running");
    });
    await fixture(async (runtime, backend) => {
      await held(runtime);
      runtime.threadLocked = () => true;
      const { writes } = await measureSqliteWrites(async () => {
        for (let i = 0; i < 1000; i++) expect((await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" })).disposition).toBe("blocked");
      });
      expectSqliteWriteBudget({ budgetFile, scenario: "blocked-retries", note: "1000 live handoff-gated retries preserve the shared hold and durable acceptance", writes });
    });
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});

it.skipIf(process.platform === "win32")("queue controls preserve content fences and restart-without-replay", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async cancel => {
    await fixture(async (runtime, backend, store, profile) => {
      const sent = await held(runtime);
      const fingerprint = store.get("waiting0").fingerprint;
      expect(await backend.handle("backend.cancelQueuedTurn", { queueEntryId: "waiting0", expectedContentHash: "stale" })).toMatchObject({ disposition: "content_changed", cancelled: false });
      expect(store.get("waiting0")).toMatchObject({ status: "queued", fingerprint });
      if (cancel) expect(await runtime.handle("cancel", { id: "waiting0" })).toMatchObject({ disposition: "cancelled" });
      else expect(await runtime.handle("release", { id: "waiting0" })).toMatchObject({ disposition: "started" });
      await runtime.stop();
      const { JobStore } = await load("src/store.js");
      runtime.store = new JobStore(path.dirname(store.directory), { version: 1, workspace: runtime.workspace, codexHome: path.join(runtime.workspace, "codex") }, profile);
      runtime.stopping = false;
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "not_found" });
      expect(runtime.submit({ id: "waiting0", threadId: "native", prompt: "waiting0" })).toMatchObject({ fingerprint, status: cancel ? "interrupted" : "unknown" });
      expect(sent).toEqual(cancel ? ["first"] : ["first", "waiting0"]);
    });
  }), { numRuns: 4 });
});

it.skipIf(process.platform === "win32")("retry verifies transient input against immutable acceptance and ignores replacement origins", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ minLength: 1, maxLength: 20 }), async text => {
    fc.pre(text !== "waiting0");
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime);
      const accepted = store.get("waiting0");
      runtime.turnQueue.updateQueuedEntryInput("waiting0", [{ type: "text", text }]);
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" })).toMatchObject({ disposition: "blocked" });
      expect(store.get("waiting0")).toEqual(accepted);
      expect(sent).toEqual(["first"]);
      runtime.turnQueue.updateQueuedEntryInput("waiting0", [{ type: "text", text: "waiting0" }]);
      expect(await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0", messageOrigin: { kind: "agent", sourceInstanceId: "forged" } })).toMatchObject({ disposition: "started" });
      expect(store.get("waiting0")).toMatchObject({ fingerprint: accepted.fingerprint });
      expect(store.get("waiting0").messageOrigin).toBeUndefined();
      expect(sent).toEqual(["first", "waiting0"]);
    });
  }), { numRuns: 8 });
});

it.skipIf(process.platform === "win32")("cross-thread release contention either admits the retry or preserves its manual hold", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 3 }), fc.nat({ max: 2 }), fc.boolean(), async (count, position, competitorFirst) => {
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime, count);
      backend.persistCreatedNativeThread({ id: "other", title: "Other", titleSource: "explicit", cwd: runtime.workspace });
      const before = backend.queuedTurns("native");
      const accepted = store.get("waiting0");
      const submit = () => runtime.submit({ id: "competitor", threadId: "other", prompt: "competitor" });
      const finishing = Promise.resolve();
      runtime.dispatches.set("finishing", finishing);
      expect(runtime.turnQueue.canStartImmediately({ backend: "codex", threadId: "other" })).toBe(false);
      runtime.dispatches.delete("finishing");
      let submitted = false;
      const observe = runtime.onEvent;
      runtime.onEvent = (event: any) => {
        observe(event);
        if (!submitted && event.method === "headless/queueChanged" && event.params.type === "queued"
          && event.params.entry.id === `waiting${position % count}`) {
          submitted = true;
          submit();
        }
      };
      if (competitorFirst) { submitted = true; submit(); await runtime.work; }
      const result = await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
      expect(submitted).toBe(true);
      if (result.disposition === "busy") {
        // A refusal cannot silently spend the operator's Retry decision.
        expect(backend.queuedTurns("native")).toEqual(before);
        expect(store.get("waiting0")).toEqual(accepted);
        runtime.notification({ method: "turn/completed", params: { threadId: "other", turn: { id: store.get("competitor").turnId, status: "completed" } } });
        await settle();
        expect(backend.queuedTurns("native")).toEqual(before);
        expect(sent).toEqual(["first", "competitor"]);
      } else {
        expect(result).toMatchObject({ disposition: "started", turnId: "turn3" });
        expect(store.get("waiting0")).toMatchObject({ status: "running", fingerprint: accepted.fingerprint });
        expect(store.get("competitor").status).toBe("queued");
        expect(sent).toEqual(["first", "waiting0"]);
        terminal(runtime, result.turnId, "failed"); await settle();
        expect(sent).toEqual(["first", "waiting0", "competitor"]);
        expect(backend.queuedTurns("native").every((entry: any) => entry.manualReleaseRequired)).toBe(true);
      }
    });
  }), { numRuns: 12, examples: [[1, 0, false], [1, 0, true]] });
});

it.skipIf(process.platform === "win32")("release admission reservations retire after native refusal and shutdown", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async shutdown => {
    await fixture(async (runtime, backend, store) => {
      await held(runtime);
      backend.persistCreatedNativeThread({ id: "other", title: "Other", titleSource: "explicit", cwd: runtime.workspace });
      let reject!: (error: Error) => void;
      runtime.codex.startTurn = async () => {
        if (!shutdown) throw new Error("Retry refused");
        return await new Promise((_resolve, fail) => { reject = fail; });
      };
      const release = backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
      if (shutdown) {
        while (!reject) await tick();
        runtime.codex.stop = async () => { reject(new Error("Stopped provider")); };
        await runtime.stop();
      }
      expect((await release).disposition).toBe("blocked");
      expect(runtime.dispatches.size).toBe(0);
      expect(runtime.queueRelease).toBeNull();
      expect(store.get("waiting0").status).toBe(shutdown ? "unknown" : "queued");
      if (!shutdown) {
        expect(backend.queuedTurns("native")[0]).toMatchObject({ queueEntryId: "waiting0", manualReleaseRequired: true });
        runtime.codex.startTurn = async ({ threadId }: any) => ({ threadId, turnId: "other-turn" });
        expect(runtime.submit({ id: "other-job", threadId: "other", prompt: "other" }).status).toBe("starting");
        await runtime.work;
        expect(store.get("other-job").status).toBe("running");
      }
    });
  }), { numRuns: 4, examples: [[false], [true]] });
});

it.skipIf(process.platform === "win32")("a same-FIFO cancellation cannot turn a reserved retry into a busy automatic send", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), async cancelHead => {
    await fixture(async (runtime, backend, store) => {
      const sent = await held(runtime, 2);
      const observe = runtime.onEvent;
      let cancellation: Promise<any> | undefined;
      runtime.onEvent = (event: any) => {
        observe(event);
        if (!cancellation && event.method === "headless/queueChanged" && event.params.type === "queued") {
          cancellation = backend.handle("backend.cancelQueuedTurn", { queueEntryId: cancelHead ? "waiting0" : "waiting1" });
        }
      };
      const result = await backend.handle("backend.releaseQueuedTurn", { queueEntryId: "waiting0" });
      expect(result.disposition).toBe("started");
      expect(await cancellation).toMatchObject({ disposition: cancelHead ? "already_admitted" : "cancelled" });
      expect(store.get("waiting0").status).toBe("running");
      expect(sent).toEqual(["first", "waiting0"]);
    });
  }), { numRuns: 4, examples: [[false], [true]] });
});

it.skipIf(process.platform === "win32")("job-specific held releases remain pending through stable retries and shutdown", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 0, max: 2 }), async (shutdown, extra) => {
    await fixture(async (runtime, backend, store) => {
      let sends = 0;
      runtime.codex = { startTurn: async () => {
        if (++sends === 2) throw new Error("Native refusal");
        return { threadId: "native", turnId: `turn${sends}` };
      }, stop: async () => {} };
      runtime.submit({ id: "first", threadId: "native", prompt: "first" }); await runtime.work;
      const request = { threadId: "native", input: [{ type: "text", text: "waiting" }], queueEntryId: "stable" };
      const envelope = { id: "accepted", sourceInstanceId: "authenticated" };
      const accepted = await backend.startTurn(request, envelope);
      const id = accepted.queueEntryId;
      const fingerprint = store.get(id).fingerprint;
      terminal(runtime, "turn1"); await settle();
      expect(backend.queuedTurns("native")[0]).toMatchObject({ queueEntryId: id, manualReleaseRequired: true });
      const sharedRelease = runtime.turnQueue.releaseEntryWithDisposition.bind(runtime.turnQueue);
      let completed = false, unlock!: () => void;
      const gate = new Promise<void>(resolve => { unlock = resolve; });
      runtime.turnQueue.releaseEntryWithDisposition = async (entryId: string) => {
        const result = await sharedRelease(entryId);
        completed = true;
        await gate;
        return result;
      };
      const release = backend.handle("backend.releaseQueuedTurn", { queueEntryId: id });
      const reservation = runtime.queueRelease.done;
      let retry: Promise<any> | undefined, stop: Promise<void> | undefined;
      let retried = false, stopped = false;
      try {
        while (!completed) await tick();
        // The owning release still needs its slot after provider confirmation.
        // Neither an unrelated enqueue nor provider cleanup can replace it.
        expect(runtime.dispatches.get(id)).toBe(reservation);
        for (let i = 0; i < extra; i++) runtime.submit({ id: `extra${i}`, threadId: "native", prompt: "extra" });
        retry = backend.startTurn(request, envelope).then((result: any) => { retried = true; return result; });
        if (shutdown) stop = runtime.stop().then(() => { stopped = true; });
        await settle();
        expect(retried).toBe(false);
        expect(stopped).toBe(false);
        expect(runtime.dispatches.get(id)).toBe(reservation);
      } finally {
        unlock();
        await Promise.all([release, retry, stop]);
      }
      expect(await release).toMatchObject({ disposition: "started", turnId: "turn3" });
      expect(await retry).toMatchObject({ queueStatus: "started", queueEntryId: id, turnId: "turn3" });
      expect(runtime.dispatches.size).toBe(0);
      expect(runtime.queueRelease).toBeNull();
      expect(store.get(id)).toMatchObject({ fingerprint, turnId: "turn3", status: shutdown ? "unknown" : "running" });
      expect(sends).toBe(3);
    });
  }), { numRuns: 6, examples: [[true, 1], [false, 0]] });
});
