import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { call } from "../src/client.js";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cli = fileURLToPath(new URL("../bin/pwragent.js", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/codex.js", import.meta.url));
const timeout = 10000;

async function eventually(check) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await delay(20);
  }
  throw new Error("Condition did not become true");
}

async function setup(t) {
  // All test artifacts stay inside the assigned checkout. Use a short root
  // because Unix-domain socket addresses have a small platform limit.
  const local = path.join(repo, ".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(path.join(local, "h"));
  const workspace = path.join(root, "w");
  const home = path.join(root, "c");
  const data = path.join(root, "f");
  for (const directory of [workspace, home, data]) mkdirSync(directory);
  chmodSync(fixture, 0o755);
  const directory = path.join(root, "profiles/t/state/headless");
  const env = { ...process.env, PWRAGENT_HOME: root, PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
  const children = [];
  function launch(args) {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.output = "";
    child.errors = "";
    child.stdout.on("data", (chunk) => { child.output += chunk; });
    child.stderr.on("data", (chunk) => { child.errors += chunk; });
    child.done = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
    children.push(child);
    return child;
  }
  const serveArgs = ["serve", "--workspace", workspace, "--codex-home", home, "--codex-bin", fixture];
  async function start() {
    const child = launch(serveArgs);
    await eventually(() => {
      if (child.exitCode !== null) throw new Error(`Daemon failed: ${child.errors}`);
      return child.output.includes('"ready":true');
    });
    return child;
  }
  async function stop(child) { child.kill("SIGTERM"); return child.done; }
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await stop(child);
    }
    rmSync(root, { recursive: true, force: true });
  });
  const daemon = await start();
  const rpc = (method, params) => call(directory, method, params);
  const submit = (id, prompt, extra = {}) => rpc("submit", { id, prompt, ...extra });
  const finished = (id) => eventually(async () => {
    const job = await rpc("show", { id });
    return ["starting", "running", "interrupting"].includes(job.status) ? null : job;
  });
  const calls = () => readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { root, workspace, home, data, directory, daemon, start, stop, rpc, submit, finished, calls, launch, serveArgs };
}

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
  await h.submit("first", "hello", { sandbox: "workspace-write" });
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
  await assert.rejects(h.submit("first", "different"), /different input/);
  assert.equal((await h.rpc("read", { id: "first" })).thread.turns.length, 1);
  assert.equal(statSync(h.directory).mode & 0o777, 0o700);
  assert.equal(statSync(path.join(h.directory, "jobs/first.json")).mode & 0o777, 0o600);
  assert.ok(!readFileSync(path.join(h.directory, "jobs/first.json"), "utf8").includes("hello"));
  assert.equal((await h.stop(h.daemon)).code, 0);
  await h.start();
  assert.equal((await h.rpc("show", { id: "first" })).status, "completed");
  await h.submit("second", "continue", { threadId: job.threadId });
  assert.equal((await h.finished("second")).status, "completed");
  assert.equal(h.calls().filter((m) => m.method === "thread/resume").length, 1);
  assert.equal((await h.rpc("read", { id: "second" })).thread.turns.length, 2);
  const waiter = h.launch(["wait", "--id", "second"]);
  assert.equal((await waiter.done).code, 0);
});

test("acceptance survives a socket disappearing before the response", { timeout }, async (t) => {
  const h = await setup(t);
  const socket = net.createConnection(path.join(h.directory, "rpc.sock"));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ version: 1, method: "submit", params: { id: "lost-client", prompt: "hello" } }) + "\n");
  await eventually(() => existsSync(path.join(h.directory, "jobs/lost-client.json")));
  socket.destroy();
  assert.equal((await h.finished("lost-client")).status, "completed");
  await h.submit("lost-client", "hello");
  assert.equal(h.calls().filter((m) => m.method === "turn/start").length, 1);
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
  for (const [prompt, status] of [["early", "completed"], ["fail", "failed"], ["approval", "blocked"], ["question", "blocked"]]) {
    await h.submit(prompt, prompt);
    assert.equal((await h.finished(prompt)).status, status);
  }
  const responses = h.calls().filter((m) => m.id === "server-request");
  assert.deepEqual(responses[0].result, { decision: "decline" });
  assert.equal(responses[1].error.code, -32601);
});

test("provider death marks uncertain work and restart does not replay", { timeout }, async (t) => {
  const h = await setup(t);
  await h.submit("crashed", "crash");
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
