// Runs only the installed CLI and a copied provider fixture; no workspace imports.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
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
async function command(args, expectedCode = 0) {
  const child = launch(args);
  assert.equal(await child.done, expectedCode, child.errors);
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
  const owned = JSON.parse(await command(["show", "--id", "smoke"]));
  writeFileSync(prompt, "slow");
  await command(["submit", "--id", "queue-active", "--thread", owned.threadId, "--prompt-file", prompt]);
  const queueDeadline = Date.now() + 10000;
  while (!JSON.parse(await command(["show", "--id", "queue-active"])).turnId) {
    assert.ok(Date.now() < queueDeadline, "Installed active queue turn did not confirm");
    await delay(20);
  }
  writeFileSync(prompt, "installed-queued-input");
  assert.equal(JSON.parse(await command(["submit", "--id", "queue-waiting", "--thread", owned.threadId, "--prompt-file", prompt])).status, "queued");
  await command(["interrupt", "--id", "queue-active"]);
  assert.equal(JSON.parse(await command(["wait", "--id", "queue-waiting"])).status, "completed");
  const queueCalls = readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(queueCalls.filter(call => call.method === "turn/start" && call.params.input[0].text === "installed-queued-input").length, 1);
  writeFileSync(prompt, "slow");
  await command(["submit", "--id", "control-active", "--thread", owned.threadId, "--prompt-file", prompt]);
  writeFileSync(prompt, "fail");
  await command(["submit", "--id", "control-fail", "--thread", owned.threadId, "--prompt-file", prompt]);
  writeFileSync(prompt, "installed-released-input");
  await command(["submit", "--id", "control-held", "--thread", owned.threadId, "--prompt-file", prompt]);
  writeFileSync(prompt, "installed-deleted-input");
  await command(["submit", "--id", "control-delete", "--thread", owned.threadId, "--prompt-file", prompt]);
  assert.equal(JSON.parse(await command(["cancel", "--id", "control-delete"])).disposition, "cancelled");
  await command(["interrupt", "--id", "control-active"]);
  assert.equal(JSON.parse(await command(["wait", "--id", "control-fail"], 2)).status, "failed");
  assert.equal(JSON.parse(await command(["release", "--id", "control-held"])).disposition, "started");
  assert.equal(JSON.parse(await command(["wait", "--id", "control-held"])).status, "completed");
  const controlCalls = readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(controlCalls.filter(call => call.method === "turn/start" && call.params.input[0].text === "installed-released-input").length, 1);
  assert.equal(controlCalls.filter(call => call.method === "turn/start" && call.params.input[0].text === "installed-deleted-input").length, 0);
  writeFileSync(prompt, "slow");
  await command(["submit", "--id", "order-active", "--thread", owned.threadId, "--prompt-file", prompt]);
  writeFileSync(prompt, "installed-paused-input");
  await command(["submit", "--id", "order-first", "--thread", owned.threadId, "--prompt-file", prompt]);
  writeFileSync(prompt, "installed-ordered-input");
  await command(["submit", "--id", "order-second", "--thread", owned.threadId, "--prompt-file", prompt]);
  assert.equal(JSON.parse(await command(["pause", "--id", "order-first"])).pauseRevision, 1);
  assert.deepEqual(JSON.parse(await command(["move", "--id", "order-second", "--before", "order-first"])).queueEntryIds, ["order-second", "order-first"]);
  await command(["interrupt", "--id", "order-active"]);
  await command(["wait", "--id", "order-second"]);
  assert.equal(JSON.parse(await command(["show", "--id", "order-first"])).status, "queued");
  assert.equal(JSON.parse(await command(["resume", "--id", "order-first"])).pauseRevision, 2);
  await command(["wait", "--id", "order-first"]);
  const orderedCalls = readFileSync(path.join(data, "calls.jsonl"), "utf8").trim().split("\n").map(JSON.parse)
    .filter(call => call.method === "turn/start" && ["installed-ordered-input", "installed-paused-input"].includes(call.params.input[0].text));
  assert.deepEqual(orderedCalls.map(call => call.params.input[0].text), ["installed-ordered-input", "installed-paused-input"]);
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
  const [{ openOutpostProfileRuntime, ThreadTurnQueue }, { JobStore }, { HeadlessBackend }, { Runtime }] = await Promise.all([
    installed("dist/federation-core.js"), installed("src/store.js"), installed("src/federation-backend.js"), installed("src/runtime.js"),
  ]);
  // The installed shared implementation also serves desktop's replacement
  // caller. It must retire accepted input before issuing a fresh identity.
  const replacementRef = { backend: "codex", threadId: "packed-replacement" };
  const replacementOrigin = { kind: "agent", sourceThread: { backend: "codex", threadId: "alice" } };
  const replacementQueue = new ThreadTurnQueue({ isThreadActive: () => true,
    startTurn: async entry => ({ ...replacementRef, turnId: entry.id }) });
  try {
    const old = await replacementQueue.submitGroupedSteer({ ...replacementRef, origin: "manual",
      input: [{ type: "text", text: "Original Alice" }], messageOrigin: replacementOrigin });
    await replacementQueue.submitGroupedSteer({ ...replacementRef, origin: "manual", input: [{ type: "text", text: "Unchanged Bob" }],
      messageOrigin: { kind: "agent", sourceThread: { backend: "codex", threadId: "bob" } } });
    await replacementQueue.submit({ ...replacementRef, id: "packed-neighbor", origin: "manual", input: [{ type: "text", text: "neighbor" }] });
    await replacementQueue.setEntryPaused(old.entry.id, true);
    const original = structuredClone(replacementQueue.getQueuedEntries(replacementRef)[0]);
    const next = await replacementQueue.replaceQueuedAgentInput(old.entry.id, [{ type: "text", text: "Fresh Alice" }], replacementOrigin.sourceThread, replacementOrigin);
    assert.notEqual(next.id, old.entry.id);
    assert.deepEqual(replacementQueue.getQueuedEntries(replacementRef).map(entry => entry.id), [next.id, "packed-neighbor"]);
    assert.equal(next.paused, true);
    assert.equal(next.pauseRevision, 1);
    assert.deepEqual(next.agentMessages.map(message => message.input[0].text), ["Fresh Alice", "Unchanged Bob"]);
    assert.ok(JSON.stringify(original.input).includes("Original Alice"));
    assert.equal(await replacementQueue.replaceQueuedAgentInput(old.entry.id, [], replacementOrigin.sourceThread), undefined);
    const bob = await replacementQueue.replaceQueuedAgentInput(old.entry.id, [{ type: "text", text: "Fresh Bob" }],
      { backend: "codex", threadId: "bob" });
    assert.ok(bob);
    assert.notEqual(bob.id, next.id);
    assert.deepEqual(bob.agentMessages.map(message => message.input[0].text), ["Fresh Alice", "Fresh Bob"]);
    assert.deepEqual(replacementQueue.getQueuedEntries(replacementRef).map(entry => entry.id), [bob.id, "packed-neighbor"]);
    assert.equal(replacementQueue.cancelEntry(old.entry.id), undefined);
  } finally { replacementQueue.close(); }
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
    const controller = new HeadlessBackend(controlled, () => {}, () => "packed-owner");
    controlled.onEvent = message => controller.event(message);
    controller.authenticateOrigin = origin => origin;
    controlled.save({ version: 1, id: "packed-control", fingerprint: "accepted-control", threadId, turnId: "packed-control", status: "running", createdAt: new Date().toISOString() });
    controlled.active = "packed-control";
    const queued = controlled.submit({ id: "packed-edit", threadId, prompt: "Packed original input" });
    const queuedRequest = { backend: "codex", threadId, queueEntryId: queued.id, forEdit: true };
    const snapshot = await controller.handle("backend.readQueuedTurn", queuedRequest);
    assert.equal(snapshot.input[0].text, "Packed original input");
    snapshot.input[0].text = "Caller mutation";
    assert.equal((await controller.handle("backend.readQueuedTurn", queuedRequest)).input[0].text, "Packed original input");
    assert.equal((await controller.handle("backend.cancelQueuedTurn", { queueEntryId: queued.id, expectedContentHash: "stale" })).disposition, "content_changed");
    assert.equal((await controller.handle("backend.cancelQueuedTurn", { queueEntryId: queued.id, expectedContentHash: snapshot.contentHash })).disposition, "cancelled");
    assert.equal(store.get(queued.id).fingerprint, queued.fingerprint);
    assert.throws(() => controlled.submit({ id: queued.id, threadId, prompt: "Packed edited input" }), /different input/);
    const replacement = controlled.submit({ id: "packed-replacement", threadId, prompt: "Packed edited input" });
    assert.notEqual(replacement.fingerprint, queued.fingerprint);
    assert.equal((await controller.handle("backend.readQueuedTurn", { ...queuedRequest, queueEntryId: replacement.id })).input[0].text, "Packed edited input");
    await controller.handle("backend.cancelQueuedTurn", { queueEntryId: replacement.id });
    // An independent fixed-shape V1 wire canonicalization; no workspace import.
    const createdAt = Date.now(), text = "Packed durable queued input";
    const durable = { clientRequest: { version: 1, id: randomUUID(), createdAt, payloadHash: createHash("sha256").update(JSON.stringify({
      createdAt, destination: { backend: "codex", instanceId: "packed-owner", threadId }, operation: "startTurn",
      request: { backend: "codex", input: [{ text, type: "text" }], threadId }, version: 1,
    })).digest("hex") }, request: { backend: "codex", threadId, input: [{ type: "text", text }] }, callerScope: "packed-device" };
    const envelope = { sourceInstanceId: "packed-issuer" };
    const receipt = await controller.handle("backend.submitTurnRequest", durable, envelope);
    assert.equal(receipt.state, "accepted");
    assert.equal(receipt.result.queueEntryId, receipt.queueEntryId);
    assert.equal((await controller.handle("backend.submitTurnRequest", durable, envelope)).queueEntryId, receipt.queueEntryId);
    await controller.handle("backend.cancelQueuedTurn", { queueEntryId: receipt.queueEntryId });
    const lookup = { backend: "codex", threadId, id: durable.clientRequest.id, callerScope: "packed-device" };
    assert.equal((await controller.handle("backend.getTurnRequest", lookup, envelope)).outcome, "cancelled");
    assert.equal(await controller.handle("backend.getTurnRequest", { ...lookup, callerScope: "other-device" }, envelope), null);
    const steerText = "Packed durable steer";
    const durableSteer = { clientRequest: { version: 1, id: randomUUID(), createdAt, payloadHash: createHash("sha256").update(JSON.stringify({
      createdAt, destination: { backend: "codex", instanceId: "packed-owner", threadId }, operation: "steerTurn",
      request: { backend: "codex", expectedTurnId: "packed-control", input: [{ text: steerText, type: "text" }], threadId }, version: 1,
    })).digest("hex") }, request: { backend: "codex", threadId, expectedTurnId: "packed-control", input: [{ type: "text", text: steerText }] }, callerScope: "packed-device" };
    const steerReceipt = await controller.handle("backend.submitSteerRequest", durableSteer, envelope);
    assert.equal(steerReceipt.state, "dispatched");
    assert.equal(steerReceipt.result.requestId, steerReceipt.queueEntryId);
    assert.equal(steerReceipt.result.turnId, "packed-control");
    assert.deepEqual(await controller.handle("backend.submitSteerRequest", durableSteer, envelope), steerReceipt);
    const steerLookup = { ...lookup, id: durableSteer.clientRequest.id };
    assert.deepEqual(await controller.handle("backend.getSteerRequest", steerLookup, envelope), steerReceipt);
    assert.equal(await controller.handle("backend.getSteerRequest", { ...steerLookup, callerScope: "other-device" }, envelope), null);
    assert.equal(await controller.handle("backend.getSteerRequest", steerLookup, { sourceInstanceId: "other-issuer" }), null);
    assert.equal(steers, 1);
    const guidance = { backend: "codex", threadId, queueEntryId: "packed-guidance", input: [{ type: "text", text: "Packed ordinary guidance" }], messageOrigin: { kind: "agent", systemReason: "packed-guidance" } };
    const admitted = await controller.handle("backend.startTurn", guidance, envelope);
    controlled.threadLocked = () => true;
    for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.get(admitted.queueEntryId).status, "queued");
    assert.equal(store.get(admitted.queueEntryId).turnId, undefined);
    assert.equal(controlled.turnQueue.getAllQueuedEntries()[0].manualReleaseRequired, true);
    assert.equal(steers, 1);
    const heldFingerprint = store.get(admitted.queueEntryId).fingerprint;
    controlled.threadLocked = () => false;
    assert.equal((await controller.handle("backend.releaseQueuedTurn", { queueEntryId: admitted.queueEntryId })).turnId, "packed-control");
    const acceptedGuidance = store.get(admitted.queueEntryId);
    assert.equal(acceptedGuidance.fingerprint, heldFingerprint);
    assert.equal(acceptedGuidance.status, "running");
    assert.equal(acceptedGuidance.turnId, "packed-control");
    assert.equal(controlled.active, "packed-control");
    assert.equal(controlled.turnQueue.getAllQueuedEntries().length, 0);
    for (let i = 0; i < 8; i++) assert.equal((await controller.handle("backend.startTurn", guidance, envelope)).queueEntryId, admitted.queueEntryId);
    assert.equal(steers, 2);
    const save = store.save.bind(store);
    let refuseOrigin = true;
    store.save = job => { if (refuseOrigin && job.messageOrigin) { refuseOrigin = false; throw new Error("origin refused"); } return save(job); };
    const request = { backend: "codex", threadId, expectedTurnId: "packed-control", requestId: "one-steer", input: [{ type: "text", text: "packed steer" }], messageOrigin: { kind: "agent" } };
    await assert.rejects(controller.handle("steerTurn", request), /origin refused/);
    await Promise.all(Array.from({ length: 3 }, () => controller.handle("controlActiveTurn", { ...request, operation: "steer" })));
    await assert.rejects(controller.handle("steerTurn", { ...request, input: [{ type: "text", text: "changed" }] }), /reused with different input/);
    await controller.handle("controlActiveTurn", { backend: "codex", threadId, expectedTurnId: "packed-control", requestId: "stop", operation: "stop" });
    assert.equal(steers, 3);
    assert.equal(interrupts, 1);
    assert.equal(store.get("packed-control").status, "interrupted");
    assert.equal(store.get(admitted.queueEntryId).status, "interrupted");
    assert.equal(store.get(admitted.queueEntryId).fingerprint, acceptedGuidance.fingerprint);
    // The installed native host must retain every failure hold even when a
    // synchronous subscriber starts cancelling the first published row.
    const failureOwner = "packed-failure-owner";
    controlled.save({ version: 1, id: failureOwner, fingerprint: "accepted-failure-owner", threadId, turnId: failureOwner,
      status: "running", createdAt: new Date().toISOString() });
    controlled.active = failureOwner;
    let failureSends = 0;
    controlled.codex.startTurn = async () => { failureSends++; return { threadId, turnId: "packed-explicit-retry" }; };
    controlled.codex.stop = async () => {};
    controlled.loadedThreads.add(threadId);
    const older = controlled.submit({ id: "packed-failure-older", threadId, prompt: "Packed older input" });
    const next = controlled.submit({ id: "packed-failure-next", threadId, prompt: "Packed next input" });
    await controlled.work;
    let cancellation;
    let nextHeld = false;
    controlled.onEvent = message => {
      controller.event(message);
      if (message.method === "headless/queueChanged" && message.params.type === "held" && message.params.entry.id === next.id) nextHeld = true;
      if (message.method === "headless/queueChanged" && message.params.type === "held" && message.params.entry.id === older.id) {
        controlled.turnQueue.setQueuedEntryTitle(next.id, "Packed generated title");
        cancellation = controller.handle("backend.cancelQueuedTurn", { queueEntryId: older.id });
      }
    };
    controlled.notification({ method: "turn/failed", params: { threadId, turn: { id: failureOwner, status: "failed", error: { message: "Packed review required" } } } });
    await new Promise(resolve => setImmediate(resolve));
    await cancellation;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(failureSends, 0);
    assert.equal(store.get(older.id).status, "interrupted");
    assert.equal(store.get(next.id).status, "queued");
    assert.equal(store.get(next.id).fingerprint, next.fingerprint);
    assert.equal(nextHeld, true);
    assert.equal(controlled.turnQueue.getAllQueuedEntries()[0].title, "Packed generated title");
    assert.deepEqual(controlled.turnQueue.getAllQueuedEntries().map(entry => [entry.id, entry.manualReleaseRequired]), [[next.id, true]]);
    assert.equal((await controller.handle("backend.releaseQueuedTurn", { queueEntryId: next.id })).disposition, "started");
    assert.equal(failureSends, 1);
    assert.equal(store.get(next.id).fingerprint, next.fingerprint);
    const heldAtShutdown = controlled.submit({ id: "packed-failure-shutdown", threadId, prompt: "Packed held at shutdown" });
    await controlled.work;
    controlled.notification({ method: "turn/failed", params: { threadId, turn: { id: "packed-explicit-retry", status: "failed", error: { message: "Review before shutdown" } } } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controlled.turnQueue.getAllQueuedEntries()[0].manualReleaseRequired, true);
    await controlled.stop();
    assert.equal(store.get(heldAtShutdown.id).status, "unknown");
    assert.equal(store.get(heldAtShutdown.id).fingerprint, heldAtShutdown.fingerprint);
    const reopened = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
    let trackedSends = 0;
    reopened.codex = { stop: async () => {}, startTurn: async () => ({ threadId, turnId: `packed-tracked-${++trackedSends}` }) };
    reopened.loadedThreads.add(threadId);
    const reopenedOwner = new HeadlessBackend(reopened, () => {}, () => "packed-owner");
    assert.deepEqual(reopened.turnQueue.getAllQueuedEntries(), []);
    assert.equal(reopened.submit({ id: heldAtShutdown.id, threadId, prompt: "Packed held at shutdown" }).status, "unknown");
    assert.equal(failureSends, 1);
    // Production Outpost publication is synchronous. Its registered terminal
    // subscriber can still request cancellation while this tracked owner ends.
    const tracked = reopened.submit({ id: "packed-tracked-owner", threadId, prompt: "Packed tracked input" });
    await reopened.work;
    const trackedOlder = reopened.submit({ id: "packed-tracked-older", threadId, prompt: "Packed tracked older" });
    const trackedNext = reopened.submit({ id: "packed-tracked-next", threadId, prompt: "Packed tracked next" });
    await reopened.work;
    let terminalCancellation;
    reopened.onEvent = message => {
      reopenedOwner.event(message);
      if (message.method === "headless/queueChanged" && message.params.type === "terminal" && message.params.entry.id === tracked.id) {
        terminalCancellation = reopenedOwner.handle("backend.cancelQueuedTurn", { queueEntryId: trackedOlder.id });
      }
    };
    reopened.notification({ method: "turn/failed", params: { threadId, turn: { id: store.get(tracked.id).turnId, status: "failed", error: { message: "Review tracked failure" } } } });
    await new Promise(resolve => setImmediate(resolve));
    await terminalCancellation;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(trackedSends, 1);
    assert.equal(store.get(tracked.id).status, "failed");
    assert.equal(store.get(trackedOlder.id).status, "interrupted");
    assert.equal(store.get(trackedNext.id).fingerprint, trackedNext.fingerprint);
    assert.deepEqual(reopened.turnQueue.getAllQueuedEntries().map(entry => [entry.id, entry.manualReleaseRequired]), [[trackedNext.id, true]]);
    assert.equal((await reopenedOwner.handle("backend.releaseQueuedTurn", { queueEntryId: trackedNext.id })).disposition, "started");
    assert.equal(trackedSends, 2);
    await reopened.stop();
    const refusedRuntime = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
    let refusalStarts = 0;
    refusedRuntime.codex = { stop: async () => {}, startTurn: async () => {
      if (++refusalStarts === 2) throw new Error("Packed provider refused submission");
      return { threadId, turnId: `packed-refusal-${refusalStarts}` };
    } };
    refusedRuntime.loadedThreads.add(threadId);
    const refusedOwner = new HeadlessBackend(refusedRuntime, () => {}, () => "packed-owner");
    refusedRuntime.submit({ id: "packed-refusal-original", threadId, prompt: "Packed original" }); await refusedRuntime.work;
    const refusedJob = refusedRuntime.submit({ id: "packed-refused", threadId, prompt: "Packed immutable refused input" });
    const refusalNext = refusedRuntime.submit({ id: "packed-refusal-next", threadId, prompt: "Packed immutable next input" });
    let refusalCancellation, refusalCovered = false;
    refusedRuntime.onEvent = message => {
      refusedOwner.event(message);
      if (message.method === "headless/queueChanged" && message.params.type === "blocked") {
        refusalCovered = refusedRuntime.turnQueue.getAllQueuedEntries().every(entry => entry.manualReleaseRequired);
        refusalCancellation = refusedOwner.handle("backend.cancelQueuedTurn", { queueEntryId: refusedJob.id });
      }
    };
    refusedRuntime.notification({ method: "turn/completed", params: { threadId, turn: { id: "packed-refusal-1", status: "completed" } } });
    for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve));
    await refusalCancellation;
    assert.equal(refusalCovered, true);
    assert.equal(refusalStarts, 2);
    assert.equal(store.get(refusedJob.id).status, "interrupted");
    assert.equal(store.get(refusedJob.id).fingerprint, refusedJob.fingerprint);
    assert.equal(store.get(refusalNext.id).fingerprint, refusalNext.fingerprint);
    assert.deepEqual(refusedRuntime.turnQueue.getAllQueuedEntries().map(entry => [entry.id, entry.manualReleaseRequired]), [[refusalNext.id, true]]);
    assert.equal((await refusedOwner.handle("backend.releaseQueuedTurn", { queueEntryId: refusalNext.id })).disposition, "started");
    assert.equal(refusalStarts, 3);
    await refusedRuntime.stop();
    assert.equal(store.get(refusalNext.id).status, "unknown");
    const heldRuntime = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
    const heldSends = [];
    heldRuntime.codex = { stop: async () => {}, startTurn: async ({ input }) => {
      heldSends.push(input[0].text);
      return { threadId, turnId: `packed-held-${heldSends.length}` };
    } };
    heldRuntime.loadedThreads.add(threadId);
    const heldOwner = new HeadlessBackend(heldRuntime, () => {}, () => "packed-owner");
    heldRuntime.submit({ id: "packed-held-active", threadId, prompt: "active" }); await heldRuntime.work;
    const pending = ["older", "next"].map(id => heldRuntime.submit({ id: `packed-held-${id}`, threadId, prompt: id }));
    await heldRuntime.work;
    for (const job of pending) await heldOwner.handle("backend.setQueuedTurnPaused", { queueEntryId: job.id, paused: true });
    heldRuntime.notification({ method: "turn/completed", params: { threadId, turn: { id: "packed-held-1", status: "completed" } } });
    await new Promise(resolve => setImmediate(resolve));
    let heldCancellation;
    heldRuntime.onEvent = message => {
      heldOwner.event(message);
      if (message.method === "headless/queueChanged" && message.params.type === "queued" && message.params.entry.id === "packed-review") {
        heldCancellation = heldOwner.handle("backend.cancelQueuedTurn", { queueEntryId: "packed-review" });
      }
    };
    for (const job of pending) await heldOwner.handle("backend.setQueuedTurnPaused", { queueEntryId: job.id, paused: false });
    heldRuntime.submit({ id: "packed-review", threadId, prompt: "Target-ended guidance" },
      { manualReleaseRequired: true, holdReason: "Target turn ended; review required" });
    await heldRuntime.work; await heldCancellation;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(heldSends, ["active"]);
    assert.deepEqual(heldRuntime.turnQueue.getAllQueuedEntries().map(entry => [entry.id, entry.manualReleaseRequired]), pending.map(job => [job.id, true]));
    for (const job of pending) assert.deepEqual(store.get(job.id), job);
    assert.equal(store.get("packed-review").status, "interrupted");
    assert.equal((await heldOwner.handle("backend.releaseQueuedTurn", { queueEntryId: pending[0].id })).disposition, "started");
    assert.deepEqual(heldSends, ["active", "older"]);
    await heldRuntime.stop();
    const afterHeld = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
    assert.deepEqual(afterHeld.turnQueue.getAllQueuedEntries(), []);
    assert.equal(afterHeld.submit({ id: pending[1].id, threadId, prompt: "next" }).status, "unknown");
    assert.equal(store.get(pending[1].id).fingerprint, pending[1].fingerprint);
    await afterHeld.stop();
    for (const steer of [false, true]) {
      const acceptedRuntime = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
      const acceptedOwner = new HeadlessBackend(acceptedRuntime, () => {}, () => "packed-owner");
      const sends = [], originalId = `packed-publication-original-${steer}`, acceptedId = `packed-publication-accepted-${steer}`;
      let rejected = 0;
      acceptedRuntime.codex = {
        stop: async () => {},
        startTurn: async ({ input }) => { sends.push(input[0].text); return { threadId, turnId: `native-${sends.length}` }; },
        steerTurn: async ({ input, expectedTurnId }) => { sends.push(input[0].text); return { threadId, turnId: expectedTurnId }; },
      };
      acceptedRuntime.loadedThreads.add(threadId);
      acceptedRuntime.onEvent = message => {
        acceptedOwner.event(message);
        if (message.method === "headless/queueChanged" && message.params.type === "started" && message.params.entry.id === acceptedId) {
          rejected++; throw new Error("Packed started observer rejected");
        }
      };
      acceptedRuntime.submit({ id: originalId, threadId, prompt: "original" }); await acceptedRuntime.work;
      const request = { id: acceptedId, threadId, prompt: "Immutable packed accepted input" };
      const controls = steer ? { delivery: "queued-steer" } : undefined;
      const accepted = acceptedRuntime.submit(request, controls); await acceptedRuntime.work;
      if (!steer) acceptedRuntime.notification({ method: "turn/completed", params: { threadId, turn: { id: "native-1", status: "completed" } } });
      for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve));
      const turnId = steer ? "native-1" : "native-2";
      assert.equal(rejected, 1);
      assert.equal(store.get(acceptedId).status, "running");
      assert.equal(store.get(acceptedId).fingerprint, accepted.fingerprint);
      assert.equal(acceptedRuntime.active, steer ? originalId : acceptedId);
      assert.deepEqual(acceptedRuntime.turnQueue.getAllQueuedEntries(), []);
      assert.equal((await acceptedOwner.handle("backend.cancelQueuedTurn", { queueEntryId: acceptedId })).disposition, "already_admitted");
      acceptedRuntime.notification({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "completed" } } });
      for (let i = 0; i < 24; i++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(store.get(acceptedId).status, "completed");
      await acceptedRuntime.stop();
      const afterAccepted = new Runtime({ store, workspace, home: codexHome, command: fixture, onFailure() {} });
      assert.equal(afterAccepted.submit(request, controls).status, "completed");
      assert.deepEqual(afterAccepted.turnQueue.getAllQueuedEntries(), []);
      assert.deepEqual(sends, ["original", "Immutable packed accepted input"]);
      await afterAccepted.stop();
    }
  } finally { profile.close(); }
  console.log("Packed CLI smoke passed: native SQLite adoption/retirement, PTY, mocked turn/transcript, federation, restart/duplicate submission, actual Claude/ACP discovery, native Codex retirement, durable queue and steering receipts/caller isolation/cancellation, shared steering retention/retry and interruption");
} finally {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await child.done;
    }
  }
}
