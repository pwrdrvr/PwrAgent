import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/runtime.js";
import { ThreadTurnStartLifecycle, ThreadTurnQueue } from "../dist/federation-core.js";

function runningRuntime(request) {
  const job = { id: "job", threadId: "thread", turnId: "turn", status: "running" };
  const jobs = new Map([[job.id, job]]);
  return Object.assign(Object.create(Runtime.prototype), {
    active: job.id, loadedThreads: new Set(), codex: { interruptTurn: (params) => request("turn/interrupt", params) },
    turnQueue: new ThreadTurnQueue({ startTurn: async () => { throw new Error("No queued start in this fixture"); } }),
    store: { jobs, get: (id) => jobs.get(id), save: (value) => { const saved = { ...value }; jobs.set(saved.id, saved); return saved; } },
    onFailure: (error) => { throw error; },
  });
}

for (const operation of ["send_private_response", "send_messaging_file", "render_messaging_pdf_pages"]) test(`${operation} receipts survive cold restart without replaying successful or uncertain sends`, async (t) => {
  const local = fileURLToPath(new URL("../../../.local/", import.meta.url));
  mkdirSync(local, { recursive: true });
  const directory = mkdtempSync(path.join(local, "tool-receipts-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const runtime = runningRuntime(async () => ({}));
  runtime.toolLedgerDirectory = directory;
  runtime.toolLedger = new Map();
  runtime.toolLedgerCount = 0;
  let sends = 0;
  runtime.messagingTools = { handleDynamicToolCall: async () => { sends++; throw new Error("Owner disconnected after accepting the send"); } };
  const call = { threadId: "thread", turnId: "turn", callId: "uncertain", namespace: "pwragent", tool: operation, arguments: { text: "mock reply" } };
  await assert.rejects(runtime.dispatchTool(call), /disconnected/);
  runtime.toolLedger = new Map();
  await assert.rejects(runtime.dispatchTool(call), /uncertain/);
  assert.equal(sends, 1);
  await assert.rejects(runtime.dispatchTool({ ...call, arguments: { text: "different" } }), /different input/);
  const response = { success: true, contentItems: [{ type: "inputText", text: "delivered" }] };
  runtime.messagingTools = { handleDynamicToolCall: async () => { sends++; return response; } };
  const accepted = { ...call, callId: "confirmed" };
  assert.deepEqual(await runtime.dispatchTool(accepted), response);
  runtime.toolLedger = new Map();
  assert.deepEqual(await runtime.dispatchTool(accepted), response);
  assert.equal(sends, 2);
});

test("turn startup delegates subscription and resume ownership to the shared client", async () => {
  const calls = [];
  const runtime = runningRuntime(async () => ({}));
  runtime.codex.startTurn = async (params) => { calls.push(params); return { threadId: "thread", turnId: "next-turn" }; };
  runtime.turnStarts = new ThreadTurnStartLifecycle({ assertAvailable() {}, withMutation: async (_identity, work) => await work(),
    assertUnlocked: async () => {}, wake: async () => {} });
  runtime.workspace = "/fixture";
  runtime.projects = { resolve: (cwd) => cwd };
  runtime.loadedThreads.add("thread");
  await runtime.start({ ...runtime.store.get("job"), sandbox: "read-only" }, "first turn");
  runtime.notification({ method: "thread/closed", params: { threadId: "thread" } });
  assert.equal(runtime.loadedThreads.has("thread"), false);
  await runtime.start({ ...runtime.store.get("job"), sandbox: "read-only" }, "next turn");
  assert.deepEqual(calls.map(({ threadId, input }) => ({ threadId, input })), [
    { threadId: "thread", input: [{ type: "text", text: "first turn" }] },
    { threadId: "thread", input: [{ type: "text", text: "next turn" }] },
  ]);
});

for (const rejection of ["RPC rejection", "synchronous rejection"]) {
  test(`interrupt can retry after ${rejection}`, async () => {
    let calls = 0;
    const runtime = runningRuntime((method, params) => {
      assert.equal(method, "turn/interrupt");
      assert.deepEqual(params, { threadId: "thread", turnId: "turn" });
      if (++calls > 1) return Promise.resolve({});
      if (rejection === "synchronous rejection") throw new Error(rejection);
      return Promise.reject(new Error(rejection));
    });
    await assert.rejects(runtime.handle("interrupt", { id: "job" }), /rejection/);
    assert.equal(runtime.store.get("job").status, "running");
    await runtime.handle("interrupt", { id: "job" });
    assert.equal(calls, 2);
    assert.equal(runtime.store.get("job").status, "interrupting");
  });
}

for (const status of ["completed", "failed", "interrupted"]) {
  test(`rejected interrupt preserves a concurrent ${status} outcome`, async () => {
    let reject;
    const runtime = runningRuntime(() => new Promise((_resolve, fail) => { reject = fail; }));
    const interrupt = runtime.handle("interrupt", { id: "job" });
    runtime.notification({ method: "turn/completed", params: { threadId: "thread", turn: {
      id: "turn", status, error: status === "failed" ? { message: "provider failure" } : null,
    } } });
    const terminal = runtime.store.get("job");
    reject(new Error("interrupt rejected"));
    await assert.rejects(interrupt, /interrupt rejected/);
    assert.equal(runtime.store.get("job"), terminal, "no rollback write may replace the terminal record");
    assert.equal(runtime.active, null);
  });
}
