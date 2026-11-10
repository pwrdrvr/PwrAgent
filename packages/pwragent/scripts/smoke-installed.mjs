// Runs only the installed CLI and a copied provider fixture; no workspace imports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const [cli, fixture, temporary] = process.argv.slice(2);
const directory = (name) => { const result = path.join(temporary, name); mkdirSync(result); return result; };
const workspace = directory("w");
const codexHome = directory("c");
const data = directory("f");
const env = { ...process.env, PWRAGENT_HOME: directory("p"), PWRAGENT_PROFILE: "t", PWRAGENT_TEST_DATA: data };
const children = [];
function launch(args) {
  const child = spawn(cli, args, { env, cwd: temporary, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  child.output = "";
  child.errors = "";
  child.stdout.on("data", (chunk) => { child.output += chunk; });
  child.stderr.on("data", (chunk) => { child.errors += chunk; });
  child.done = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  return child;
}
async function command(args) {
  const child = launch(args);
  assert.equal(await child.done, 0, child.errors);
  return child.output;
}
async function start() {
  const daemon = launch(["serve", "--workspace", workspace, "--codex-home", codexHome, "--codex-bin", fixture]);
  const deadline = Date.now() + 10000;
  while (!daemon.output.includes('"ready":true')) {
    assert.equal(daemon.exitCode, null, daemon.errors);
    assert.ok(Date.now() < deadline, "Installed daemon did not become ready");
    await delay(20);
  }
  return daemon;
}
async function stop(daemon) { daemon.kill("SIGTERM"); assert.equal(await daemon.done, 0, daemon.errors); }

try {
  assert.match(await command(["--help"]), /PwrAgent Headless/);
  // The installed CLI must read its own packed manifest, release metadata included.
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(realpathSync(cli)), "../package.json"), "utf8"));
  assert.match(await command(["--version"]), new RegExp(`^pwragent ${manifest.version.replaceAll(".", "\\.")}\\b`));
  assert.equal(JSON.parse(await command(["version"])).version, manifest.version);
  // Exercise native input, resize and exit from the offline-installed tarball.
  const installedRequire = createRequire(realpathSync(cli));
  const terminal = installedRequire("node-pty").spawn("/bin/sh", [], { cwd: temporary, cols: 80, rows: 24 });
  let terminalExited = false;
  let terminalOutput = "";
  let terminalTimer;
  const dataListener = terminal.onData((data) => { terminalOutput += data; });
  try {
    const exited = new Promise((resolve, reject) => {
      terminalTimer = setTimeout(() => reject(new Error("Installed native PTY did not exit")), 10000);
      terminal.onExit((event) => { terminalExited = true; resolve(event); });
    });
    terminal.resize(100, 30);
    terminal.write("printf 'native-%s\\n' 'pty-ok'; exit\n");
    assert.equal((await exited).exitCode, 0);
    assert.ok(terminalOutput.includes("native-pty-ok"), terminalOutput);
  } finally {
    clearTimeout(terminalTimer);
    dataListener.dispose();
    if (!terminalExited) terminal.kill();
  }
  const headless = path.join(env.PWRAGENT_HOME, "profiles/t/state/headless");
  mkdirSync(path.join(headless, "jobs"), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(headless, "identity.json"), JSON.stringify({ version: 1, workspace, codexHome }));
  const legacyThreads = JSON.stringify({ version: 1, threads: [
    { id: "legacy-thread", title: "Packed legacy owner", titleSource: "explicit", createdAt: 1, sandbox: "read-only", pinnedRank: "a0" },
    { id: "pending-packed", title: "Packed pending import", titleSource: "derived", sandbox: "read-only" },
  ] });
  writeFileSync(path.join(headless, "threads.json"), legacyThreads);
  writeFileSync(path.join(headless, "jobs/legacy.json"), JSON.stringify({ version: 1, id: "legacy", status: "running", fingerprint: "retained", threadId: "legacy-thread", createdAt: "2026-01-01T00:00:00Z" }));
  let daemon = await start();
  assert.equal(JSON.parse(await command(["show", "--id", "legacy"])).status, "unknown");
  assert.equal(existsSync(path.join(headless, "threads.json")), false);
  assert.equal(existsSync(path.join(headless, "jobs/legacy.json")), false);
  assert.equal(readFileSync(path.join(headless, "legacy-owner-backup-v1/threads.json"), "utf8"), legacyThreads);
  const Database = installedRequire("better-sqlite3");
  const reader = new Database(path.join(path.dirname(headless), "state.db"), { readonly: true });
  try {
    assert.equal(reader.pragma("user_version", { simple: true }), 81);
    assert.equal(JSON.parse(reader.prepare("SELECT payload FROM threads WHERE json_extract(payload, '$.threadId') = ?").get("legacy-thread").payload).pinnedRank, "a0");
  } finally { reader.close(); }
  const status = JSON.parse(await command(["status"]));
  assert.equal(status.activeJob, null);
  assert.equal(status.running.version, manifest.version);
  assert.equal(status.restartRequired, false);
  const prompt = path.join(temporary, "prompt.txt");
  writeFileSync(path.join(data, "helper-title.json"), JSON.stringify({ title: "Packed helper title" }));
  writeFileSync(prompt, "packed-install");
  await command(["submit", "--id", "smoke", "--prompt-file", prompt, "--sandbox", "workspace-write"]);
  assert.equal(JSON.parse(await command(["wait", "--id", "smoke"])).status, "completed");
  assert.equal(readFileSync(path.join(workspace, "fixture-result.txt"), "utf8"), "packed-install");
  const transcript = JSON.parse(await command(["read", "--id", "smoke"]));
  assert.equal(transcript.thread.turns[0].items[0].text, "Fixture result");
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  await command(["federation-invite", "--port", String(port), "--label", "Packed fixture"]);
  assert.ok(JSON.parse(await command(["federation-status"])).instanceId);
  await stop(daemon);
  daemon = await start();
  assert.equal(JSON.parse(await command(["show", "--id", "smoke"])).status, "completed");
  await command(["submit", "--id", "smoke", "--prompt-file", prompt, "--sandbox", "workspace-write"]);
  const calls = readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.filter((call) => call.method === "turn/start").length, 2, "one user turn and one ephemeral title helper; no replay after restart");
  assert.equal(calls.filter((call) => call.method === "thread/start" && call.params.ephemeral === true).length, 1);
  assert.equal(calls.filter((call) => call.method === "thread/unsubscribe").length, 1);
  await stop(daemon);
  // Actual profile discovery must work from the installed bundle with no
  // provider process or retained Claude inventory.
  const state = path.dirname(headless);
  const claudeId = "00000000-0000-4000-8000-000000000001";
  mkdirSync(path.join(state, "claude"), { mode: 0o700 });
  writeFileSync(path.join(state, "claude", `${claudeId}.json`), JSON.stringify({ cwd: workspace, sdkSessionId: "private-sdk-id",
    thread: { id: claudeId, source: "claude", title: "Packed Claude metadata", titleSource: "derived", archivedAt: 3,
      createdAt: 1, updatedAt: 2, executionMode: "auto", linkedDirectories: [] } }), { mode: 0o600 });
  const packageRoot = path.resolve(path.dirname(realpathSync(cli)), "..");
  const installed = file => import(pathToFileURL(path.join(packageRoot, file)).href);
  const [{ openOutpostProfileRuntime }, { JobStore }, { HeadlessBackend }, { Runtime }] = await Promise.all([
    installed("dist/federation-core.js"), installed("src/store.js"), installed("src/federation-backend.js"), installed("src/runtime.js"),
  ]);
  const profile = openOutpostProfileRuntime({ stateDirectory: state, profileName: "t", cwd: workspace });
  try {
    const store = new JobStore(headless, { version: 1, workspace, codexHome }, profile);
    assert.equal(store.threadRegistry.getThreadMetadata({ backend: "codex", threadId: store.get("smoke").threadId }).title.text, "Packed helper title");
    const owner = new HeadlessBackend({ workspace, store, projects: { list: () => [] }, onFailure(error) { throw error; } }, () => {});
    const detail = await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref: { backend: "claude", threadId: claudeId } });
    assert.equal(detail.identity, "archived");
    assert.equal(detail.thread.title, "Packed Claude metadata");
    assert.equal(detail.thread.executionMode, "auto");
    assert.ok(!JSON.stringify(detail).includes("private-sdk-id"));
    const native = new Database(path.join(state, "state.db"));
    const ref = { backend: "acp:uninstalled", threadId: claudeId };
    try {
      native.prepare("INSERT INTO acp_sessions(backend_id, session_id, created_at, updated_at, payload) VALUES (?, ?, ?, ?, ?)")
        .run(ref.backend, ref.threadId, 1, 2, JSON.stringify({ backendId: ref.backend, sessionId: ref.threadId,
          title: "Packed actual ACP", titleSource: "derived", cwd: workspace, createdAt: 1, updatedAt: 2,
          archivedAt: 3, executionMode: "auto", status: "idle" }));
      await store.threadRegistry.updateThreadMetadata(ref, { pinnedRank: "1024" });
      store.inventory.replace({ backend: ref.backend, observedAt: Date.now(), threads: [{ id: ref.threadId,
        source: ref.backend, title: "Packed stale ACP", archivedAt: 3, linkedDirectories: [] }] });
      assert.equal((await owner.handle("resolveThread", ref)).thread.title, "Packed actual ACP");
      native.prepare("DELETE FROM acp_sessions WHERE backend_id = ? AND session_id = ?").run(ref.backend, ref.threadId);
      assert.equal((await owner.handle("resolveThread", ref)).thread, undefined);
      assert.equal((await owner.handle("getNavigationSelectedDetail", { protocol: 2, ref })).identity, "unresolved");
      assert.deepEqual((await owner.handle("lookupArchivedThreads", { backend: ref.backend, threadIds: [ref.threadId], includeParent: true })).parentLinks, []);
      assert.equal(store.threadRegistry.getThreadMetadata(ref).pinnedRank, "1024");
      assert.equal((await owner.handle("resolveThread", { backend: "claude", threadId: claudeId })).thread.title, "Packed Claude metadata");
    } finally { native.close(); }
    const codexRef = { backend: "codex", threadId: claudeId };
    await store.threadRegistry.updateThreadMetadata(codexRef, { title: { text: "Packed native Codex", source: "derived", nativeName: "Packed native Codex" }, pinnedRank: "2048" });
    const acceptedBefore = [...store.jobs.values()];
    let present = true;
    const runtime = { workspace, store, projects: { list: () => [] }, onFailure(error) { throw error; },
      codex: { listThreads: async ({ archived }) => present && !archived
        ? [{ id: claudeId, source: "codex", title: "Packed native Codex", titleSource: "explicit", linkedDirectories: [] }] : [] } };
    let membership = new HeadlessBackend(runtime, () => {});
    await membership.initialize();
    assert.equal((await membership.handle("resolveThread", codexRef)).thread.pinnedRank, "2048");
    present = false;
    await membership.refreshThreads();
    for (let round = 0; round < 2; round++) {
      assert.equal((await membership.handle("resolveThread", codexRef)).thread, undefined);
      assert.equal(membership.threads.get("pending-packed").title, "Packed pending import");
      assert.ok(membership.threads.get(store.get("smoke").threadId));
      const retained = store.retainedOwners.list();
      assert.equal(retained.find(thread => thread.id === "pending-packed").title, "Packed pending import");
      assert.ok(retained.some(thread => thread.id === store.get("smoke").threadId));
      assert.ok(!retained.some(thread => thread.id === codexRef.threadId), "a retired native overlay is not independent retention evidence");
      assert.deepEqual([...store.jobs.values()], acceptedBefore);
      assert.equal((await membership.handle("resolveThread", { backend: "claude", threadId: claudeId })).thread.title, "Packed Claude metadata");
      membership = new HeadlessBackend(runtime, () => {});
      await membership.initialize();
    }
    // Exercise the actual packaged host wiring with its installed coordinators
    // and native storage. An accepted steer survives refused origin retention.
    const controlled = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
    let steers = 0;
    let interrupts = 0;
    const threadId = store.get("smoke").threadId;
    controlled.codex = {
      steerTurn: async () => { steers++; return { threadId, turnId: "packed-control" }; },
      interruptTurn: async () => {
        interrupts++;
        controlled.notification({ method: "turn/completed", params: { threadId, turn: { id: "packed-control", status: "interrupted" } } });
        return {};
      },
    };
    const controller = new HeadlessBackend(controlled, () => {});
    controlled.onEvent = message => controller.event(message);
    controller.authenticateOrigin = origin => origin;
    controlled.save({ version: 1, id: "packed-control", fingerprint: "accepted-control", threadId, turnId: "packed-control", status: "running", createdAt: new Date().toISOString() });
    controlled.active = "packed-control";
    const save = store.save.bind(store);
    let refuseOrigin = true;
    store.save = job => { if (refuseOrigin && job.messageOrigin) { refuseOrigin = false; throw new Error("origin refused"); } return save(job); };
    const request = { backend: "codex", threadId, expectedTurnId: "packed-control", requestId: "one-steer", input: [{ type: "text", text: "packed steer" }], messageOrigin: { kind: "agent" } };
    await assert.rejects(controller.handle("steerTurn", request), /origin refused/);
    await Promise.all(Array.from({ length: 3 }, () => controller.handle("controlActiveTurn", { ...request, operation: "steer" })));
    await assert.rejects(controller.handle("steerTurn", { ...request, input: [{ type: "text", text: "changed" }] }), /reused with different input/);
    await controller.handle("controlActiveTurn", { backend: "codex", threadId, expectedTurnId: "packed-control", requestId: "stop", operation: "stop" });
    assert.equal(steers, 1);
    assert.equal(interrupts, 1);
    assert.equal(store.get("packed-control").status, "interrupted");
  } finally { profile.close(); }
  console.log("Packed CLI smoke passed: native SQLite adoption/retirement, PTY, mocked turn/transcript, federation, restart/duplicate submission, actual Claude/ACP discovery, native Codex retirement, shared steering retention/retry and interruption");
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await child.done;
    }
  }
}
