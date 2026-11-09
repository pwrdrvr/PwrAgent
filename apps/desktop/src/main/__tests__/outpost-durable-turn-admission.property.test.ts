import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { canonicalDurableTurnRequest, type SubmitDurableTurnRequest } from "@pwragent/shared";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "@pwragent/sqlite-storage/sqlite-write-metrics";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

const load = (file: string) => import(/* @vite-ignore */ pathToFileURL(path.join(process.cwd(), "packages/pwragent/src", file)).href);
const ref = { backend: "codex" as const, threadId: "native" };
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

async function fixture(work: (f: any) => Promise<void>) {
  const [{ JobStore }, { Runtime }, { HeadlessFederation }] = await Promise.all([load("store.js"), load("runtime.js"), load("federation.js")]);
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-durable-")));
  const profile = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  let runtime: any;
  try {
    const store = new JobStore(path.join(root, "headless"), { version: 1, workspace: root, codexHome: path.join(root, "codex") }, profile);
    runtime = new Runtime({ store, workspace: root, home: path.join(root, "codex"), command: "unused", onFailure() {} });
    const sent: any[] = [], events: any[] = [];
    runtime.codex = { startTurn: async (request: any) => {
      sent.push(request);
      return { threadId: ref.threadId, turnId: `turn-${sent.length}` };
    }, stop: async () => {} };
    const federation = new HeadlessFederation({ directory: path.join(root, "headless"), runtime, profile: "fixture", onFailure() {} });
    federation.ensureIdentity("fixture");
    federation.publish = (event: any) => events.push(event.notification);
    const backend = federation.backend;
    backend.persistCreatedNativeThread({ id: ref.threadId, title: "Existing", titleSource: "explicit", cwd: root });
    const envelope = { sourceInstanceId: "issuer", targetInstanceId: federation.state.instanceId, id: "transport" };
    const submit = (value: SubmitDurableTurnRequest, callerScope = "device", sourceInstanceId = "issuer") => backend.handle("backend.submitTurnRequest", { ...value, callerScope }, { ...envelope, sourceInstanceId });
    const get = (value: SubmitDurableTurnRequest, callerScope = "device", sourceInstanceId = "issuer") => backend.handle("backend.getTurnRequest", { ...ref, id: value.clientRequest.id, callerScope }, { ...envelope, sourceInstanceId });
    const value = (text = "waiting", id = randomUUID()): SubmitDurableTurnRequest => {
      const request: SubmitDurableTurnRequest = { clientRequest: { version: 1, id, createdAt: Date.now(), payloadHash: "" }, request: { ...ref,
        input: [{ type: "text", text }], messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "sender", instanceId: "forged" } } } };
      request.clientRequest.payloadHash = createHash("sha256").update(canonicalDurableTurnRequest(federation.state.instanceId, request)).digest("hex");
      return request;
    };
    const active = () => { runtime.submit({ id: "active", threadId: ref.threadId, prompt: "active" }); return runtime.work; };
    const terminal = () => runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: store.get(runtime.active).turnId, status: "completed" } } });
    await work({ runtime, backend, federation, store, profile, sent, events, submit, get, value, active, terminal });
  } finally {
    if (runtime) await runtime.stop();
    profile.close(); rmSync(root, { recursive: true, force: true });
  }
}

it.skipIf(process.platform === "win32")("generated durable retries share one real queue identity and changed accepted input requires cancellation and a new UUID", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("retry", "pause", "move", "changed", "read"), { minLength: 1, maxLength: 16 }), async operations => {
    await fixture(async ({ runtime, backend, store, sent, submit, get, value, active, terminal }: any) => {
      await active();
      const request = value(), receipt = await submit(request), accepted = store.get(receipt.queueEntryId);
      expect(receipt).toMatchObject({ ...ref, state: "accepted", result: { queueStatus: "queued", queueEntryId: receipt.queueEntryId } });
      expect(accepted).toMatchObject({ status: "queued", messageOrigin: { sourceThread: { instanceId: "issuer" } } });
      for (const operation of operations) {
        if (operation === "retry") expect(await submit(request)).toEqual(receipt);
        else if (operation === "read") expect(await get(request)).toEqual(receipt);
        else if (operation === "changed") await expect(submit(value("changed", request.clientRequest.id))).rejects.toMatchObject({ code: "request_conflict" });
        else if (operation === "pause") await runtime.setQueuedTurnPaused({ queueEntryId: receipt.queueEntryId, paused: true });
        else await runtime.moveQueuedTurn({ queueEntryId: receipt.queueEntryId });
        expect(store.get(receipt.queueEntryId).fingerprint).toBe(accepted.fingerprint);
        expect(sent).toHaveLength(1);
      }
      await runtime.cancelQueuedTurn({ queueEntryId: receipt.queueEntryId });
      expect(await get(request)).toMatchObject({ state: "completed", outcome: "cancelled", payloadHash: receipt.payloadHash });
      expect(await submit(request)).toMatchObject({ state: "completed", outcome: "cancelled" });
      const changed = await submit(value("changed"));
      expect(changed.queueEntryId).not.toBe(receipt.queueEntryId);
      expect(backend.queuedTurns(ref.threadId).map((entry: any) => entry.queueEntryId)).toEqual([changed.queueEntryId]);
      terminal(); await settle();
      expect(sent.map((request: any) => request.input[0].text)).toEqual(["active", "changed"]);
      expect(await get(request)).toMatchObject({ state: "completed", outcome: "cancelled" });
    });
  }), { numRuns: 6 });
});

it.skipIf(process.platform === "win32")("durable caller namespaces isolate receipts and concurrent claims dispatch once through native terminal completion", async () => {
  await fixture(async ({ runtime, submit, get, value, sent, terminal, events }: any) => {
    const request = value("direct");
    const results = await Promise.all(Array.from({ length: 12 }, () => submit(request)));
    const receipt = await get(request);
    expect(results.every((result: any) => result.queueEntryId === receipt.queueEntryId)).toBe(true);
    expect(receipt).toMatchObject({ state: "dispatched", result: { turnId: "turn-1", queueStatus: "started" } });
    expect(sent).toHaveLength(1);
    expect(await get(request, "other-device")).toBeNull();
    expect(await get(request, "device", "other-issuer")).toBeNull();
    terminal(); await settle();
    expect(await get(request)).toMatchObject({ state: "completed", outcome: "completed", result: { turnId: "turn-1" } });
    expect(events.some((event: any) => event.method === "thread/turnQueue/updated" && event.params.queueEntryId === receipt.queueEntryId && event.params.status === "terminal")).toBe(true);
    expect(runtime.active).toBeNull();
  });
});

it.skipIf(process.platform === "win32")("shutdown and recovered jobs never restore durable queued input or replay accepted receipts", async () => {
  await fixture(async ({ runtime, backend, federation, submit, get, value, active, sent, store }: any) => {
    await active();
    const request = value(), receipt = await submit(request), accepted = store.get(receipt.queueEntryId);
    await runtime.stop();
    expect(store.get(receipt.queueEntryId)).toMatchObject({ status: "unknown", fingerprint: accepted.fingerprint });
    expect(await get(request)).toMatchObject({ state: "uncertain" });
    // A fresh host service on the same durable ports has no FIFO to restore.
    const { HeadlessBackend } = await load("federation-backend.js");
    const reopened = new HeadlessBackend(runtime, () => {}, () => federation.state.instanceId);
    expect(await reopened.handle("backend.submitTurnRequest", { ...request, callerScope: "device" }, { sourceInstanceId: "issuer" })).toMatchObject({ state: "uncertain" });
    expect(backend.queuedTurns(ref.threadId)).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify([...store.jobs.values()])).not.toContain('"input"');
  });
});

it.skipIf(process.platform === "win32")("shutdown overtaking queued acceptance returns uncertainty immediately and never restores input", async () => {
  await fixture(async ({ runtime, submit, get, value, active, sent }: any) => {
    await active();
    const observer = runtime.onEvent;
    let stopped: Promise<void> | undefined;
    runtime.onEvent = (event: any) => {
      observer(event);
      if (event.method === "headless/jobChanged" && event.params.status === "queued") stopped = runtime.stop();
    };
    const request = value();
    expect(await submit(request)).toMatchObject({ state: "uncertain" });
    await stopped;
    expect(await get(request)).toMatchObject({ state: "uncertain" });
    expect(runtime.turnQueue.getAllQueuedEntries()).toEqual([]);
    expect(sent).toHaveLength(1);
  });
});

it.skipIf(process.platform === "win32")("receipt admission and claim commit before native dispatch and a provider interruption is cancellation", async () => {
  await fixture(async ({ runtime, store, submit, get, value }: any) => {
    const request = value("direct");
    const native = runtime.codex.startTurn;
    runtime.codex.startTurn = async (params: any) => {
      const scope = JSON.stringify(["federation", "issuer", "device"]);
      const receipt = store.durableTurnRequests.read(scope, request.clientRequest.id);
      expect(receipt).toMatchObject({ state: "dispatching" });
      expect(store.get(receipt.queueEntryId).status).toBe("starting");
      return native(params);
    };
    const receipt = await submit(request);
    runtime.notification({ method: "turn/completed", params: { threadId: ref.threadId, turn: { id: receipt.result.turnId, status: "interrupted" } } });
    await settle();
    expect(await get(request)).toMatchObject({ state: "completed", outcome: "cancelled" });
  });
});

it.skipIf(process.platform === "win32")("durable storage and provider refusals preserve claims and never resend accepted unknown work", async () => {
  for (const phase of ["accept", "claim", "result", "native", "confirm"]) {
    await fixture(async ({ runtime, store, submit, get, value, active, sent }: any) => {
      if (["accept", "claim", "result"].includes(phase)) await active();
      const request = value(), storage = store.durableTurnRequests;
      const insert = storage.insert, write = storage.write, save = store.save.bind(store);
      let refuse = true;
      storage.insert = (...args: any[]) => { if (refuse && phase === "accept") { refuse = false; throw new Error("refused"); } return insert(...args); };
      storage.write = (scope: string, receipt: any) => {
        if (refuse && ((phase === "claim" && receipt.state === "dispatching") || (phase === "result" && receipt.result))) { refuse = false; throw new Error("refused"); }
        return write(scope, receipt);
      };
      if (phase === "native") runtime.codex.startTurn = async () => { sent.push("attempt"); throw new Error("private native refusal"); };
      if (phase === "confirm") store.save = (job: any) => { if (refuse && job.turnId) { refuse = false; throw new Error("refused"); } return save(job); };
      if (phase === "accept" || phase === "claim") {
        await expect(submit(request)).rejects.toThrow("refused");
        expect(await get(request)).toEqual(phase === "accept" ? null : expect.objectContaining({ state: "accepted" }));
        expect(sent).toHaveLength(1);
        expect(await submit(request)).toMatchObject({ state: "accepted", result: { queueStatus: "queued" } });
      } else {
        const receipt = await submit(request);
        expect(receipt.state).toBe(phase === "confirm" ? "dispatched" : "uncertain");
        const count = sent.length;
        for (let n = 0; n < 8; n++) expect(await submit(request)).toEqual(receipt);
        expect(sent).toHaveLength(count);
        if (phase === "confirm") expect(store.get(receipt.queueEntryId)).toMatchObject({ status: "unknown", turnId: "turn-1" });
      }
      storage.insert = insert; storage.write = write; store.save = save;
    });
  }
});

it.skipIf(process.platform === "win32")("durable turn admission writes only at acceptance, claim and queue outcome boundaries", async () => {
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  // JobStore stamps wall time before its unchanged-payload SQL guard. Freeze
  // Date alone so row counts do not depend on crossing a millisecond; drains
  // and provider scheduling continue to use real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-09T16:00:00Z"));
  try {
    await fixture(async ({ runtime, submit, get, value, active, terminal }: any) => {
      await active();
      const request = value();
      const admitted = await measureSqliteWrites(() => submit(request));
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "queued-admission", note: "Actual durable receipt admission/claim, owner job acceptance and queued receipt result; setup excluded", writes: admitted.writes });
      const duplicates = await measureSqliteWrites(async () => { for (let n = 0; n < 100; n++) { await submit(request); await get(request); } });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "duplicate-read", note: "100 matching durable submissions and receipt reads; no dispatch", writes: duplicates.writes });
      const cancelled = await measureSqliteWrites(() => runtime.cancelQueuedTurn({ queueEntryId: admitted.result.queueEntryId }));
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "queued-cancellation", note: "Existing durable owner cancellation and receipt terminal boundary", writes: cancelled.writes });
      const next = value("next");
      await submit(next);
      const dispatched = await measureSqliteWrites(async () => { terminal(); await settle(); });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "queued-dispatch", note: "Prior owner terminal plus queued native dispatch/confirmation and durable receipt started boundary; initial admission excluded", writes: dispatched.writes });
      const completed = await measureSqliteWrites(async () => { terminal(); await settle(); });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "native-completion", note: "Native terminal owner outcome and durable receipt completion; no per-item writes", writes: completed.writes });
    });
    await fixture(async ({ submit, value, terminal }: any) => {
      const started = await measureSqliteWrites(() => submit(value("direct")));
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "direct-admission", note: "Actual idle-host durable receipt admission/claim, existing owner native dispatch/confirmation and receipt result; terminal excluded", writes: started.writes });
      terminal(); await settle();
    });
    await fixture(async ({ runtime, submit, get, value, active }: any) => {
      await active();
      const request = value();
      await submit(request);
      const shutdown = await measureSqliteWrites(() => runtime.stop());
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "shutdown-uncertain", note: "Graceful shutdown settles one active plus one queued owner job and its queued receipt without replay", writes: shutdown.writes });
      const reads = await measureSqliteWrites(async () => { for (let n = 0; n < 100; n++) { await get(request); await submit(request); } });
      expectSqliteWriteBudget({ budgetFile: "outpost-durable-turn-write-budgets.json", scenario: "uncertain-retries", note: "100 reads and retries of stopped uncertain acceptance; no dispatch or prompt restoration", writes: reads.writes });
    });
  } finally { vi.useRealTimers(); vi.unstubAllEnvs(); }
});
