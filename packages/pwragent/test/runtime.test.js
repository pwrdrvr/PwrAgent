import assert from "node:assert/strict";
import test from "node:test";
import { Codex } from "../src/codex.js";
import { Runtime } from "../src/runtime.js";

function runningRuntime(request) {
  let job = { id: "job", threadId: "thread", turnId: "turn", status: "running" };
  return Object.assign(Object.create(Runtime.prototype), {
    active: job.id, codex: { request },
    store: { get: () => job, save: (value) => { job = { ...value }; return job; } },
    onFailure: (error) => { throw error; },
  });
}

for (const rejection of ["RPC rejection", "pending limit", "synchronous rejection"]) {
  test(`interrupt can retry after ${rejection}`, async () => {
    let calls = 0;
    const runtime = runningRuntime((method, params) => {
      assert.equal(method, "turn/interrupt");
      assert.deepEqual(params, { threadId: "thread", turnId: "turn" });
      if (++calls > 1) return Promise.resolve({});
      if (rejection === "pending limit") return Codex.prototype.request.call({ pending: { size: 32 } }, method, params);
      if (rejection === "synchronous rejection") throw new Error(rejection);
      return Promise.reject(new Error(rejection));
    });
    await assert.rejects(runtime.handle("interrupt", { id: "job" }), /rejection|Too many pending/);
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
