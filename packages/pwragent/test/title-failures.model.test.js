import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ownerStorage } from "./helpers/owner-storage.js";
import { Codex } from "../src/codex.js";
import { Runtime } from "../src/runtime.js";
import { JobStore } from "../src/store.js";
import { HeadlessBackend } from "../src/federation-backend.js";

function barrier() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}

async function fixture(t, control = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pa-title-failure-")));
  const home = path.join(root, "codex");
  mkdirSync(home);
  const command = path.join(root, "codex-fixture");
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./fixtures/codex.js", import.meta.url)))} "$@"\n`);
  chmodSync(command, 0o755);
  writeFileSync(path.join(root, "helper-title.json"), JSON.stringify({ title: "Helper generated title", ...control }));
  const previous = process.env.PWRAGENT_TEST_DATA;
  process.env.PWRAGENT_TEST_DATA = root;
  let runtime;
  // Match daemon ownership: runtime shutdown drains before owner storage closes.
  t.after(async () => {
    await runtime?.failureStop;
    await runtime?.stop();
    if (previous === undefined) delete process.env.PWRAGENT_TEST_DATA;
    else process.env.PWRAGENT_TEST_DATA = previous;
  });
  const owner = ownerStorage(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new JobStore(owner.directory, owner.identity, owner.profile);
  const failures = [];
  runtime = new Runtime({ store, workspace: root, home, command, onFailure: error => failures.push(error) });
  // Exercise the daemon's real failure action, including uncertain job outcome.
  runtime.onFailure = error => { failures.push(error); runtime.failureStop ??= runtime.stop(); };
  runtime.codex = new Codex({ command, home, workspace: root, timeout: 1000,
    onNotification: message => { runtime.notification(message); runtime.onEvent?.(message); },
    onRequest: message => runtime.serverRequest(message),
    onFailure: error => { runtime.codexFailure = error; runtime.onFailure(error); },
  });
  const generate = runtime.codex.generateTitle.bind(runtime.codex);
  runtime.codex.generateTitle = params => generate({ ...params, timeoutMs: 50, turnTimeoutMs: 50 });
  const backend = new HeadlessBackend(runtime, () => {});
  runtime.onEvent = message => backend.event(message);
  await runtime.codex.initialize();
  return { root, runtime, backend, failures,
    calls: () => readFileSync(path.join(root, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse),
  };
}

// The provider process is the shutdown oracle. Enumerate the asynchronous
// setup/application boundaries at which an admitted helper can resume late.
for (const pauseAt of ["generateTitle", "resolveHelperModelSelection", "renameThread"]) {
  test(`shutdown owns the final provider stop after title ${pauseAt} resumes`, async t => {
    const { runtime, backend, failures } = await fixture(t);
    const entered = barrier();
    const resume = barrier();
    const original = runtime.codex[pauseAt].bind(runtime.codex);
    runtime.codex[pauseAt] = async (...args) => { entered.release(); await resume.promise; return original(...args); };
    runtime.submit({ id: "shutdown", prompt: "slow" });
    await runtime.work;
    await entered.promise;
    const firstStop = barrier();
    const stop = runtime.codex.stop.bind(runtime.codex);
    runtime.codex.stop = async () => { await stop(); firstStop.release(); };
    const stopping = runtime.stop();
    await firstStop.promise;
    resume.release();
    await stopping;
    const survivor = runtime.codex.child?.pid;
    // Reap the regression's process before asserting, including on red code.
    await stop();
    assert.equal(survivor, undefined, "Runtime.stop returned with a live Codex process");
    assert.equal(runtime.store.get("shutdown").status, "unknown");
    assert.equal(failures.length, 0);
    await backend.titles.whenSettled();
  });
}

// A stalled helper at each protocol boundary must leave the concurrently
// running user job and App Server intact. A user RPC stall stays fatal.
for (const stalledMethod of ["model/list", "config/read", "thread/start", "mcpServerStatus/list", "turn/start", "thread/unsubscribe", "thread/name/set"]) {
  test(`optional title ${stalledMethod} timeout preserves the user turn`, async t => {
    const { runtime, backend, failures, calls } = await fixture(t, { stalledMethod });
    runtime.submit({ id: "user", prompt: "slow" });
    await runtime.work;
    const accepted = runtime.store.get("user");
    const fallback = backend.owned(accepted.threadId).title;
    const pid = runtime.codex.child.pid;
    await backend.titles.whenSettled();
    assert.ok(calls().some(call => call.method === stalledMethod));
    assert.equal(failures.length, 0, "an optional helper timeout reached daemon onFailure");
    assert.equal(runtime.codex.child?.pid, pid);
    assert.deepEqual(runtime.store.get("user"), accepted, "helper failure changed durable user acceptance/outcome");
    // Model discovery can still select the configured fallback model; failed
    // cleanup cannot discard an already completed answer.
    assert.equal(backend.owned(accepted.threadId).title,
      ["model/list", "thread/unsubscribe"].includes(stalledMethod) ? "Helper generated title" : fallback);
    await runtime.handle("interrupt", { id: "user" });
    assert.equal(runtime.store.get("user").status, "interrupted");
  });
}

test("a user mutation timeout remains daemon-fatal outside concurrent title work", async t => {
  const { runtime, backend, failures, root } = await fixture(t);
  const entered = barrier();
  const resume = barrier();
  const generate = runtime.codex.generateTitle.bind(runtime.codex);
  runtime.codex.generateTitle = async params => { entered.release(); await resume.promise; return generate(params); };
  runtime.submit({ id: "user", prompt: "slow" });
  await runtime.work;
  await entered.promise;
  writeFileSync(path.join(root, "helper-title.json"), JSON.stringify({ title: "Helper title", stalledMethod: "turn/interrupt" }));
  try { await runtime.handle("interrupt", { id: "user" }); }
  finally { resume.release(); }
  await runtime.failureStop;
  await runtime.stop();
  await backend.titles.whenSettled();
  assert.ok(failures.some(error => /json-rpc timeout/.test(error.message)));
  assert.equal(runtime.store.get("user").status, "unknown");
});
