import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { setup, eventually } from "./helpers.js";
const timeout = 10000;

test("real CLI submits once, disconnects, reads results and explicitly continues across daemon restart", { timeout }, async (t) => {
  const h = await setup(t);
  const file = path.join(h.root, "prompt.txt");
  writeFileSync(file, "hello");
  const client = h.launch(["submit", "--id", "first", "--prompt-file", file, "--sandbox", "workspace-write"]);
  assert.equal((await client.done).code, 0, client.errors);
  assert.equal(JSON.parse(client.output).status, "starting");
  const job = await h.finished("first");
  assert.equal(job.status, "completed");
  assert.equal(readFileSync(path.join(h.workspace, "fixture-result.txt"), "utf8"), "hello");
  const workspacePolicy = { type: "workspaceWrite", writableRoots: [h.workspace], networkAccess: false,
    excludeTmpdirEnvVar: true, excludeSlashTmp: true };
  assert.deepEqual(h.calls().find((message) => message.method === "turn/start").params.sandboxPolicy, workspacePolicy);
  await h.submit("first", "hello", { sandbox: "workspace-write" });
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
  await assert.rejects(h.submit("first", "different"), /different input/);
  assert.equal((await h.rpc("read", { id: "first" })).thread.turns.length, 1);
  assert.equal(statSync(h.directory).mode & 0o777, 0o700);
  assert.equal(existsSync(path.join(h.directory, "jobs/first.json")), false);
  const reader = new Database(path.join(path.dirname(h.directory), "state.db"), { readonly: true });
  try { assert.ok(!reader.prepare("SELECT payload FROM owner_jobs WHERE job_id = ?").get("first").payload.includes("hello")); }
  finally { reader.close(); }
  assert.equal((await h.stop(h.daemon)).code, 0);
  await h.start();
  assert.equal((await h.rpc("show", { id: "first" })).status, "completed");
  await h.submit("second", "continue", { threadId: job.threadId, sandbox: "workspace-write" });
  assert.equal((await h.finished("second")).status, "completed");
  assert.equal(h.calls().filter((m) => m.method === "thread/resume").length, 1);
  assert.deepEqual(h.calls().filter((message) => message.method === "turn/start").at(-1).params.sandboxPolicy, workspacePolicy);
  assert.equal((await h.rpc("read", { id: "second" })).thread.turns.length, 2);
  const waiter = h.launch(["wait", "--id", "second"]);
  assert.equal((await waiter.done).code, 0);
});

test("acceptance survives a socket disappearing before the response", { timeout }, async (t) => {
  const h = await setup(t);
  const socket = net.createConnection(path.join(h.directory, "rpc.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ version: 1, method: "submit", params: { id: "lost-client", prompt: "hello" } }) + "\n");
  await eventually(async () => (await h.rpc("list")).some(job => job.id === "lost-client"));
  socket.destroy();
  assert.equal((await h.finished("lost-client")).status, "completed");
  await h.submit("lost-client", "hello");
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
});

test("real CLI queues continued jobs, cancels before dispatch and never replays unfinished queue input after restart", { timeout }, async (t) => {
  const h = await setup(t);
  await h.submit("seed", "hello");
  const { threadId } = await h.finished("seed");
  await h.submit("active", "slow", { threadId });
  await eventually(async () => (await h.rpc("show", { id: "active" })).turnId);
  const prompt = path.join(h.root, "queued.txt");
  writeFileSync(prompt, "queued-cli");
  const submitted = h.launch(["submit", "--id", "queued", "--thread", threadId, "--prompt-file", prompt]);
  assert.equal((await submitted.done).code, 0, submitted.errors);
  assert.equal(JSON.parse(submitted.output).status, "queued");
  await h.submit("cancelled", "cancelled", { threadId });
  assert.equal((await h.rpc("interrupt", { id: "cancelled" })).status, "interrupted");
  const waiter = h.launch(["wait", "--id", "queued"]);
  await h.rpc("interrupt", { id: "active" });
  assert.equal((await waiter.done).code, 0, waiter.errors);
  assert.equal((await h.finished("queued")).status, "completed");
  assert.deepEqual(h.calls().filter(call => call.method === "turn/start").map(call => call.params.input[0].text), ["hello", "slow", "queued-cli"]);
  await h.submit("shutdown-active", "slow", { threadId });
  await eventually(async () => (await h.rpc("show", { id: "shutdown-active" })).turnId);
  const accepted = await h.submit("shutdown-queued", "never-replay", { threadId });
  assert.equal(accepted.status, "queued");
  assert.equal((await h.stop(h.daemon)).code, 0);
  await h.start();
  const recovered = await h.submit("shutdown-queued", "never-replay", { threadId });
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.fingerprint, accepted.fingerprint);
  assert.equal(h.calls().filter(call => call.method === "turn/start").length, 4);
});

test("real CLI pauses and orders waiting input, resumes once and never replays after restart", { timeout }, async t => {
  const h = await setup(t);
  await h.submit("seed", "hello");
  const { threadId } = await h.finished("seed");
  await h.submit("active", "slow", { threadId });
  await eventually(async () => (await h.rpc("show", { id: "active" })).turnId);
  for (const id of ["first", "second"]) await h.submit(id, "slow", { threadId });
  const control = async args => {
    const process = h.launch(args);
    assert.equal((await process.done).code, 0, process.errors);
    return JSON.parse(process.output);
  };
  assert.deepEqual(await control(["pause", "--id", "first"]), { queueEntryId: "first", disposition: "updated", paused: true, pauseRevision: 1 });
  assert.equal((await control(["move", "--id", "second", "--before", "first"])).disposition, "moved");
  await h.rpc("interrupt", { id: "active" });
  await eventually(async () => (await h.rpc("show", { id: "second" })).turnId);
  assert.equal((await h.rpc("show", { id: "first" })).status, "queued");
  assert.equal((await control(["resume", "--id", "first"])).pauseRevision, 2);
  await h.rpc("interrupt", { id: "second" });
  await eventually(async () => (await h.rpc("show", { id: "first" })).turnId);
  const accepted = await h.submit("unfinished", "never-replay", { threadId });
  await control(["pause", "--id", "unfinished"]);
  assert.equal((await h.stop(h.daemon)).code, 0);
  await h.start();
  assert.equal((await control(["resume", "--id", "unfinished"])).disposition, "not_found");
  assert.equal((await h.submit("unfinished", "never-replay", { threadId })).fingerprint, accepted.fingerprint);
  assert.equal((await h.rpc("show", { id: "unfinished" })).status, "unknown");
  assert.equal(h.calls().filter(call => call.method === "turn/start").length, 4);
});

test("concurrent submit has one owner; busy rejects without a queued record; duplicate daemon cannot disturb owner", { timeout }, async (t) => {
  const h = await setup(t);
  const outcomes = await Promise.allSettled([h.submit("one", "slow"), h.submit("two", "slow")]);
  assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1);
  const winner = outcomes.find((o) => o.status === "fulfilled").value.id;
  assert.equal((await h.rpc("list")).length, 1);
  const duplicate = h.launch(h.serveArgs);
  assert.equal((await duplicate.done).code, 1);
  assert.match(duplicate.errors, /owner lock/);
  await eventually(async () => (await h.rpc("show", { id: winner })).turnId);
  await h.rpc("interrupt", { id: winner });
  assert.equal((await h.finished(winner)).status, "interrupted");
  const waiter = h.launch(["wait", "--id", winner]);
  assert.equal((await waiter.done).code, 2);
});

test("early terminal events, failed turns and interactive requests have honest outcomes", { timeout }, async (t) => {
  const h = await setup(t);
  for (const [prompt, status] of [["early", "completed"], ["returned", "completed"], ["fail", "failed"], ["approval", "blocked"], ["question", "blocked"]]) {
    await h.submit(prompt, prompt);
    assert.equal((await h.finished(prompt)).status, status);
  }
  const responses = h.calls().filter((m) => m.id === "server-request");
  assert.deepEqual(responses[0].result, { decision: "decline" });
  assert.equal(responses[1].error.code, -32603);
  assert.match(responses[1].error.message, /Interactive requests are not supported/);
});

test("provider death marks uncertain work and restart does not replay", { timeout }, async (t) => {
  const h = await setup(t);
  await h.submit("crashed", "crash");
  await eventually(async () => {
    const job = await h.rpc("show", { id: "crashed" });
    return job.status === "running" && existsSync(path.join(h.data, "crash.ready"));
  });
  const owner = JSON.parse(readFileSync(path.join(h.directory, "owner.lock"), "utf8"));
  process.kill(owner.codexPid, "SIGUSR1");
  assert.equal((await h.daemon.done).code, 1);
  await h.start();
  assert.equal((await h.rpc("show", { id: "crashed" })).status, "unknown");
  await h.submit("crashed", "crash");
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
});

test("abrupt daemon death refuses stale ownership until explicit recovery, then never replays", { timeout }, async (t) => {
  const h = await setup(t);
  await h.submit("abrupt", "slow");
  await eventually(async () => (await h.rpc("show", { id: "abrupt" })).turnId);
  const owner = JSON.parse(readFileSync(path.join(h.directory, "owner.lock"), "utf8"));
  h.daemon.kill("SIGKILL");
  await h.daemon.done;
  // Simulate the service manager cleaning the test-owned cgroup. Never use
  // a discovered operator PID; this PID came from our newly launched fixture.
  try { process.kill(-owner.codexPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const refused = h.launch(h.serveArgs);
  assert.equal((await refused.done).code, 1);
  assert.match(refused.errors, /owner lock/);
  for (const name of ["owner.lock", "rpc.sock"]) rmSync(path.join(h.directory, name), { force: true });
  // Shared profile leases retain desktop's persisted dead-owner grace even
  // after the operator explicitly removes the headless lock. Observe the
  // refusal, then advance only this fixture's durable death timestamp to the
  // grace boundary; no wall-clock sleep or provider work is needed.
  const grace = h.launch(h.serveArgs);
  assert.equal((await grace.done).code, 1);
  assert.match(grace.errors, /Profile federation lease is held/);
  const db = new Database(path.join(path.dirname(h.directory), "state.db"));
  try {
    const dead = db.prepare("SELECT instance_id, exited_at FROM app_runtime_instances WHERE process_id = ?").get(h.daemon.pid);
    const lease = db.prepare("SELECT expires_at FROM messaging_runtime_lease WHERE owner_instance_id = ? AND lease_key = 'profile-federation'").get(dead.instance_id);
    assert.equal(lease.expires_at - dead.exited_at, 60_000);
    db.prepare("UPDATE app_runtime_instances SET exited_at = ? WHERE instance_id = ?").run(Date.now() - 60_000, dead.instance_id);
  } finally { db.close(); }
  await h.start();
  assert.equal((await h.rpc("show", { id: "abrupt" })).status, "unknown");
  await h.submit("abrupt", "slow");
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
});

test("SIGTERM reaps ordinary process descendants and records unfinished work as unknown", { timeout }, async (t) => {
  const h = await setup(t);
  await h.submit("tree", "descendant");
  await eventually(() => existsSync(path.join(h.data, "descendant.pid")));
  await eventually(() => existsSync(path.join(h.data, "descendant.ready")));
  const pid = Number(readFileSync(path.join(h.data, "descendant.pid"), "utf8"));
  await h.stop(h.daemon);
  await eventually(() => {
    try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; }
  });
  await h.start();
  assert.equal((await h.rpc("show", { id: "tree" })).status, "unknown");
});

test("rejects invalid scope and inputs before inference", { timeout }, async (t) => {
  const h = await setup(t);
  await assert.rejects(h.submit("../escape", "hello"), /Job ID/);
  await assert.rejects(h.submit("external", "hello", { threadId: "operator-thread" }), /Only threads/);
  await assert.rejects(h.submit("unsafe", "hello", { sandbox: "danger-full-access" }), /Sandbox/);
  await assert.rejects(h.submit("empty", " "), /Prompt/);
  await assert.rejects(h.rpc("command/exec", {}), /Unknown command/);
  assert.equal(h.calls().filter((m) => m.method === "thread/start").length, 0);
  const badFlags = h.launch(["status", "--sandbox", "workspace-write"]);
  assert.equal((await badFlags.done).code, 1);
});
