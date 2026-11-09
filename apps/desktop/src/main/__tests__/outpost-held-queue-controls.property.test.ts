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
