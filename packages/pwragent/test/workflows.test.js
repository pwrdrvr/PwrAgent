import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { connectFederationClient, decodeFederationInvite, FederationRpcEndpoint, generateFederationIdentityKeyPair,
  generateNoiseStaticKeyPair } from "../dist/federation-core.js";
import { HEADLESS_CAPABILITIES } from "../src/federation.js";
import { OutpostGit } from "../src/projects.js";
import { setup, eventually } from "./helpers.js";

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function peer(h, prior, onRequest) {
  const listener = (await h.rpc("federation-status")).listener;
  const invite = prior?.invite || decodeFederationInvite((await h.rpc("federation-invite", { port: listener ? Number(new URL(listener.url).port) : await port() })).invite);
  const identity = prior?.identity || { id: randomUUID(), ...generateFederationIdentityKeyPair(), noiseStatic: generateNoiseStaticKeyPair() };
  const events = [];
  const endpoints = [];
  let rpc;
  const connection = await connectFederationClient({ url: invite.gatewayUrl, mode: prior ? "reconnect" : "enroll", deferReceiving: true,
    gatewayInstanceId: invite.gatewayInstanceId, gatewayPublicKeyPem: invite.gatewayPublicKeyPem,
    gatewayNoisePublicKey: Buffer.from(invite.gatewayNoisePublicKey, "base64"), peerInstanceId: identity.id,
    ...identity, capabilities: HEADLESS_CAPABILITIES, role: "client", inviteToken: prior ? undefined : invite.token,
    onEnvelope: (envelope) => {
      if (rpc.receiveEnvelope(envelope) || endpoints.some((endpoint) => endpoint.receiveEnvelope(envelope))) return;
      events.push(envelope);
      if (envelope.kind === "request" && onRequest) void Promise.resolve(onRequest(envelope)).then((result) => connection.sendEnvelope({
        kind: "response", id: randomUUID(), requestId: envelope.id, protocolVersion: envelope.protocolVersion,
        sourceInstanceId: identity.id, targetInstanceId: invite.gatewayInstanceId, createdAt: Date.now(), result,
      }));
    }, onClose: () => rpc.rejectAll(new Error("Fixture peer disconnected")),
  });
  rpc = new FederationRpcEndpoint({ localInstanceId: identity.id, remoteInstanceId: invite.gatewayInstanceId,
    sendEnvelope: (envelope) => connection.sendEnvelope(envelope), defaultTimeoutMs: 5000 });
  connection.startReceiving();
  return { invite, identity, events, connection, rpc, remote: (instanceId) => {
    const endpoint = new FederationRpcEndpoint({ localInstanceId: identity.id, remoteInstanceId: instanceId,
      sendEnvelope: (envelope) => connection.sendEnvelope(envelope), defaultTimeoutMs: 5000 });
    endpoints.push(endpoint);
    return (method, params = {}) => endpoint.request({ method, params });
  }, call: (method, params = {}) => rpc.request({ method, params }) };
}

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();

function repository(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory);
  git(directory, "init", "-b", "main");
  writeFileSync(path.join(directory, "README.md"), "disposable repository\n");
  git(directory, "add", ".");
  git(directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  return directory;
}

test("project creation, clone, project-specific turns and restart use owner cwd", async (t) => {
  const h = await setup(t);
  const origin = repository(h.root, "origin");
  const v = await peer(h);
  t.after(() => v.connection.close());
  const project = await v.call("outpost.projects.create", { name: "clone", remote: origin });
  const blank = h.launch(["project-create", "--name", "blank"]);
  assert.equal((await blank.done).code, 0);
  assert.equal((await h.rpc("project-list")).length, 3);
  const created = await v.call("backend.startThread", { backend: "codex", cwd: project.path, executionMode: "auto" });
  const specs = h.calls().find((call) => call.method === "thread/start").params.dynamicTools;
  assert.ok(specs.some((namespace) => namespace.tools?.some((tool) => tool.name === "send_private_response")));
  assert.ok(!specs.some((namespace) => namespace.tools?.some((tool) => tool.name === "send_messaging_file")));
  await v.call("backend.startTurn", { threadId: created.threadId, input: [{ type: "text", text: "project marker" }] });
  await eventually(() => existsSync(path.join(project.path, "fixture-result.txt")));
  assert.equal(existsSync(path.join(h.workspace, "fixture-result.txt")), false);
  const page = await v.call("backend.getNavigationQueryPage", { protocol: 2, query: { kind: "directory", directoryKey: project.path } });
  assert.equal(page.entries[0].row.projectKey, project.path);
  await assert.rejects(v.call("backend.startTurn", { threadId: created.threadId, cwd: h.workspace, input: [{ type: "text", text: "wrong cwd" }] }), /cwd|workspace|project/i);
  v.connection.close();
  await h.stop(h.daemon);
  await h.start();
  const reconnected = await peer(h, v);
  t.after(() => reconnected.connection.close());
  await reconnected.call("backend.startTurn", { threadId: created.threadId, input: [{ type: "text", text: "after restart" }] });
  await eventually(() => readFileSync(path.join(project.path, "fixture-result.txt"), "utf8") === "after restart");
  assert.equal(h.calls().filter((call) => call.method === "turn/start").at(-1).params.cwd, project.path);
});

test("Git authentication is explicit, private and does not inherit ambient helpers or SSH agents", async (t) => {
  const h = await setup(t);
  const invocations = [];
  const adapter = new OutpostGit(h.directory, async (...args) => { invocations.push(args); return { stdout: "", stderr: "" }; });
  await adapter.git(h.workspace, ["clone", "--", "https://example.invalid/private.git", "dest"]);
  let [, args, options] = invocations.at(-1);
  assert.ok(args.includes("credential.helper="));
  assert.equal(options.env.SSH_AUTH_SOCK, undefined);
  assert.equal(options.env.GIT_ASKPASS, undefined);
  assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.ok(args.some((arg) => arg.includes("IdentityAgent=none")));
  const key = path.join(h.root, "outpost-key");
  const hosts = path.join(h.root, "outpost-known-hosts");
  const helper = path.join(h.root, "outpost helper");
  for (const file of [key, hosts, helper]) { writeFileSync(file, "fixture", { mode: 0o600 }); chmodSync(file, 0o600); }
  chmodSync(helper, 0o700);
  adapter.configure({ sshKeyPath: key, knownHostsPath: hosts, credentialHelperPath: helper });
  await adapter.git(h.workspace, ["fetch"]);
  [, args, options] = invocations.at(-1);
  assert.ok(args.some((arg) => arg.includes(key)));
  assert.ok(args.some((arg) => arg.includes(helper)));
  chmodSync(key, 0o644);
  await assert.rejects(adapter.git(h.workspace, ["fetch"]), /private/);
  const denied = new OutpostGit(h.directory, async () => { throw new Error("mock authentication failure with secret"); });
  chmodSync(key, 0o600);
  writeFileSync(helper, "#!/bin/sh\nprintf 'username=fixture\\npassword=mock-only\\n'\n");
  const realGit = new OutpostGit(h.directory);
  const credentials = await realGit.git(h.workspace, ["credential", "fill"], { input: "protocol=https\nhost=example.invalid\n\n" });
  assert.match(credentials.stdout, /username=fixture/);
  assert.match(credentials.stdout, /password=mock-only/);
  await assert.rejects(denied.git(h.workspace, ["fetch"]), (error) => /explicitly configured/.test(error.message) && !error.message.includes("secret"));
  await assert.rejects(h.rpc("project-clone", { name: "bad-clone", remote: path.join(h.root, "missing-private-repository") }), /Git operation failed/);
  assert.equal(existsSync(path.join(h.workspace, "bad-clone")), false);
  await assert.rejects(h.rpc("project-clone", { name: "credentials", remote: "https://token@example.invalid/private.git" }), /credential-free/);
});

test("remote terminal input, resize, peer ownership, reconnect, history and shutdown cleanup", { timeout: 20000 }, async (t) => {
  const h = await setup(t);
  let v = await peer(h);
  t.after(() => v.connection.close());
  const project = await h.rpc("project-create", { name: "terminal" });
  const thread = await v.call("backend.startThread", { cwd: project.path });
  const session = await v.call("pty.open", { backend: "codex", threadId: thread.threadId, cols: 80, rows: 24 });
  assert.equal(session.cwd, project.path);
  await v.call("pty.input", { sessionId: session.sessionId, dataBase64: Buffer.from("printf 'OUTPOST_PTY_OK\\n'; printf '%s' $$ > terminal-shell.pid; pwd\n").toString("base64") });
  await eventually(() => v.events.some((event) => event.method === "pty.output" && Buffer.from(event.params.dataBase64, "base64").toString().includes("OUTPOST_PTY_OK")));
  await v.call("pty.resize", { sessionId: session.sessionId, cols: 103, rows: 31 });
  await v.call("pty.input", { sessionId: session.sessionId, dataBase64: Buffer.from("stty size\n").toString("base64") });
  await eventually(() => v.events.some((event) => event.method === "pty.output" && Buffer.from(event.params.dataBase64, "base64").toString().includes("31 103")));
  const attacker = await peer(h);
  t.after(() => attacker.connection.close());
  await assert.rejects(attacker.call("pty.input", { sessionId: session.sessionId, dataBase64: "eA==" }), /owned|belong|session/i);
  v.connection.close();
  v = await peer(h, v);
  const snapshot = await v.call("pty.snapshot", { sessionId: session.sessionId });
  assert.ok(snapshot.snapshot.data.includes("OUTPOST_PTY_OK"));
  const list = await v.call("pty.list", { backend: "codex", threadId: thread.threadId });
  assert.equal(list.length, 1);
  const pid = Number(readFileSync(path.join(project.path, "terminal-shell.pid"), "utf8"));
  v.connection.close();
  await h.stop(h.daemon);
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  await h.start();
  v = await peer(h, v);
  const restored = await v.call("pty.list", { backend: "codex", threadId: thread.threadId });
  assert.equal(restored[0].status, "restored");
  const resumed = await v.call("pty.open", { backend: "codex", threadId: thread.threadId, resumeSessionId: session.sessionId, cols: 90, rows: 25 });
  assert.equal(resumed.sessionId, session.sessionId);
  await v.call("pty.close", { sessionId: resumed.sessionId });
});

test("repository intake preflights before file transfer or source archive, then validates imported history", { timeout: 30000 }, async (t) => {
  const source = await setup(t);
  const destination = await setup(t);
  const origin = repository(source.root, "seed");
  const published = path.join(source.root, "published.git");
  git(source.root, "clone", "--bare", origin, published);
  const sourceProject = await source.rpc("project-clone", { name: "source", remote: published });
  const destProject = await destination.rpc("project-clone", { name: "destination", remote: published });
  const gatewayPort = await port();
  const enrollment = await source.rpc("federation-invite", { port: gatewayPort });
  await destination.rpc("federation-join", { invite: enrollment.invite });
  await eventually(async () => (await destination.rpc("federation-status")).gateway.status === "connected");
  const targetInstanceId = (await destination.rpc("federation-status")).instanceId;
  const viewer = await peer(source);
  t.after(() => viewer.connection.close());
  const thread = await viewer.call("backend.startThread", { cwd: sourceProject.path });
  await viewer.call("backend.startTurn", { threadId: thread.threadId, input: [{ type: "text", text: "intake history" }] });
  await eventually(() => existsSync(path.join(sourceProject.path, "fixture-result.txt")));
  git(sourceProject.path, "add", ".");
  git(sourceProject.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture result");
  git(sourceProject.path, "push", "origin", "main");
  const request = { sourceThreadId: thread.threadId, targetInstanceId, operation: "move" };
  await assert.rejects(viewer.call("thread.handoff.send", { ...request, targetRepositoryPath: path.join(destination.workspace, "missing") }), /not owned|not available|repository/);
  assert.equal(destination.calls().filter((call) => call.method === "thread/fork").length, 0);
  assert.equal(existsSync(path.join(destination.directory, "incoming")), false);
  assert.equal(source.calls().filter((call) => call.method === "thread/archive").length, 0);
  git(destProject.path, "remote", "set-url", "origin", "https://example.invalid/wrong-repository.git");
  await assert.rejects(viewer.call("thread.handoff.send", { ...request, targetRepositoryPath: destProject.path }), /no remote matching/);
  assert.equal(source.calls().filter((call) => call.method === "thread/archive").length, 0);
  assert.equal(existsSync(path.join(destination.directory, "incoming")), false);
  git(destProject.path, "remote", "set-url", "origin", published);
  const result = await viewer.call("thread.handoff.send", { ...request, targetRepositoryPath: destProject.path });
  assert.equal(result.sourceArchived, true);
  assert.equal(result.instanceId, targetInstanceId);
  assert.ok(destination.calls().some((call) => call.method === "thread/fork"));
  assert.ok(source.calls().some((call) => call.method === "fs/readFile"), "export uses App Server instead of private storage");
  await destination.stop(destination.daemon);
  await destination.start();
  const destinationViewer = await peer(destination);
  t.after(() => destinationViewer.connection.close());
  const imported = await destinationViewer.call("backend.readThread", { threadId: result.threadId });
  assert.equal(imported.replay.lastAssistantMessage, "Fixture result");
  const row = await destinationViewer.call("backend.resolveThread", { threadId: result.threadId });
  assert.ok(row.thread.projectKey.startsWith(destProject.path + path.sep));
  await destinationViewer.call("backend.startTurn", { threadId: result.threadId, input: [{ type: "text", text: "intake continued" }] });
  assert.equal(destination.calls().filter((call) => call.method === "turn/start").at(-1).params.cwd, row.thread.projectKey);
});

test("gateway loss reaps a relayed viewer's terminal while outpost execution continues", { timeout: 30000 }, async (t) => {
  const gateway = await setup(t);
  const outpost = await setup(t);
  const issued = await gateway.rpc("federation-invite", { port: await port() });
  await outpost.rpc("federation-join", { invite: issued.invite });
  const instanceId = (await outpost.rpc("federation-status")).instanceId;
  const viewer = await peer(gateway);
  t.after(() => viewer.connection.close());
  const remote = viewer.remote(instanceId);
  const thread = await remote("backend.startThread", {});
  const session = await remote("pty.open", { backend: "codex", threadId: thread.threadId, cols: 80, rows: 24 });
  await remote("pty.input", { sessionId: session.sessionId, dataBase64: Buffer.from("printf '%s' $$ > relay-shell.pid\n").toString("base64") });
  const marker = path.join(outpost.workspace, "relay-shell.pid");
  const pid = await eventually(() => {
    if (!existsSync(marker)) return false;
    const value = Number(readFileSync(marker, "utf8"));
    return Number.isInteger(value) && value > 0 ? value : false;
  });
  await outpost.submit("gateway-independent", "work survives gateway loss");
  await gateway.stop(gateway.daemon);
  assert.equal((await outpost.finished("gateway-independent")).status, "completed");
  await eventually(() => { try { process.kill(pid, 0); return false; } catch (error) { return error.code === "ESRCH"; } }, 15000);
  await gateway.start();
  await eventually(async () => (await outpost.rpc("federation-status")).gateway.status === "connected");
  const restoredViewer = await peer(gateway, viewer);
  t.after(() => restoredViewer.connection.close());
  const restoredRemote = restoredViewer.remote(instanceId);
  const sessions = await restoredRemote("pty.list", { backend: "codex", threadId: thread.threadId });
  assert.equal(sessions[0].sessionId, session.sessionId);
  assert.equal(sessions[0].status, "restored");
});

test("incoming messaging preserves causal context and authorized tools return to the provider-owning peer", { timeout: 20000 }, async (t) => {
  const h = await setup(t);
  const provider = { authorized: true, sends: [], checks: [], requests: [] };
  let owner = await peer(h, undefined, (envelope) => {
    assert.equal(envelope.method, "messaging.destination");
    const operation = envelope.params;
    if (operation.kind === "authorize") { provider.checks.push(operation); return { allowed: provider.authorized }; }
    provider.requests.push(operation.request);
    if (operation.request.operation === "send_private_response") {
      provider.sends.push(operation.request.args.text);
      if (provider.disconnectAfterSend) { owner.connection.close(); return new Promise(() => {}); }
      return { ok: true, data: { outcome: "delivered", deliveredAt: Date.now(), channel: "slack", recipient: { platformUserId: "fixture-user" } } };
    }
    return { ok: true, data: { location: { channel: "slack", conversation: { id: "fixture-conversation", kind: "thread" } } } };
  });
  t.after(() => owner.connection.close());
  const thread = await owner.call("backend.startThread", { cwd: h.workspace });
  const messageOrigin = { kind: "messaging", causalMessagingSource: { ownerId: "fixture-profile", requestId: "fixture-request", instanceId: owner.identity.id },
    messaging: { platform: "slack", surface: { id: "fixture-conversation", kind: "thread" }, actor: { platformUserId: "fixture-user" } } };
  owner.connection.sendEnvelope({ kind: "notification", id: randomUUID(), protocolVersion: 1, createdAt: Date.now(),
    sourceInstanceId: owner.identity.id, targetInstanceId: owner.invite.gatewayInstanceId, method: "federation.eventSubscription",
    params: { eventClasses: ["transcript"], threadSelection: { kind: "threads", threads: [{ backend: "codex", threadId: thread.threadId }] } } });
  const send = () => owner.call("backend.startTurn", { threadId: thread.threadId, messageOrigin,
    input: [{ type: "text", text: 'tool {"operation":"send_private_response","args":{"text":"mock-only private reply"}}' }] });
  await send();
  await eventually(() => provider.sends.length === 1);
  await eventually(() => owner.events.some((event) => event.method === "backend.event" && event.params.notification.method === "turn/completed"));
  assert.equal(provider.requests[0].context.causalMessagingSource.instanceId, owner.identity.id);
  assert.deepEqual(provider.requests[0].context.causalMessagingSource, messageOrigin.causalMessagingSource);
  assert.equal(provider.checks[0].check.category, "messaging_context");
  const forged = structuredClone(messageOrigin);
  forged.causalMessagingSource.instanceId = randomUUID();
  await assert.rejects(owner.call("backend.startTurn", { threadId: thread.threadId, messageOrigin: forged, input: [{ type: "text", text: "forged" }] }), /authenticated/);
  provider.authorized = false;
  await send();
  await eventually(() => readFileSync(path.join(h.data, "tool-results.jsonl"), "utf8").trim().split("\n").length === 2);
  assert.equal(provider.sends.length, 1);
  const denied = JSON.parse(readFileSync(path.join(h.data, "tool-results.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(denied.success, false);
  assert.match(denied.contentItems[0].text, /forbidden/);
  provider.authorized = true;
  provider.disconnectAfterSend = true;
  await send();
  await eventually(() => readFileSync(path.join(h.data, "tool-results.jsonl"), "utf8").trim().split("\n").length === 3);
  const uncertain = JSON.parse(readFileSync(path.join(h.data, "tool-results.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(uncertain.success, false);
  assert.match(uncertain.contentItems[0].text, /peer_unavailable|uncertain/);
  assert.equal(provider.sends.length, 2, "the provider may have accepted one uncertain send");
  owner.connection.close();
  await h.stop(h.daemon);
  await h.start();
  owner = await peer(h, owner);
  assert.equal(provider.sends.length, 2, "restart and reconnect cannot replay the uncertain send");
  const history = await owner.call("backend.readThread", { threadId: thread.threadId });
  assert.ok(history.replay.lastAssistantMessage);
  // Viewer or provider loss never stops an independently accepted agent turn.
  await owner.call("backend.startTurn", { threadId: thread.threadId, messageOrigin: { kind: "messaging",
    messaging: { platform: "discord", surface: { id: "fixture-discord", kind: "thread" }, actor: { platformUserId: "fixture-discord-actor" } } },
    input: [{ type: "text", text: "independent work" }] });
  owner.connection.close();
  await eventually(() => existsSync(path.join(h.workspace, "fixture-result.txt")) && readFileSync(path.join(h.workspace, "fixture-result.txt"), "utf8") === "independent work");
});
