import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import {
  connectFederationClient, decodeFederationInvite, FederationRpcEndpoint,
  generateFederationIdentityKeyPair, generateNoiseStaticKeyPair,
} from "../dist/federation-core.js";
import { HEADLESS_CAPABILITIES, HeadlessFederation } from "../src/federation.js";
import { setup, eventually } from "./helpers.js";

async function port() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}

async function viewer(invite, identity = { id: randomUUID(), ...generateFederationIdentityKeyPair(), noiseStatic: generateNoiseStaticKeyPair() }, mode = "enroll", capabilities = HEADLESS_CAPABILITIES) {
  const events = [];
  let rpc;
  const connection = await connectFederationClient({ url: invite.gatewayUrl, mode,
    gatewayInstanceId: invite.gatewayInstanceId, gatewayPublicKeyPem: invite.gatewayPublicKeyPem,
    gatewayNoisePublicKey: Buffer.from(invite.gatewayNoisePublicKey, "base64"),
    peerInstanceId: identity.id, privateKeyPem: identity.privateKeyPem, publicKeyPem: identity.publicKeyPem,
    noiseStatic: identity.noiseStatic, capabilities, role: "client", inviteToken: mode === "enroll" ? invite.token : undefined,
    connectTimeoutMs: 1000, deferReceiving: true,
    onEnvelope: (envelope) => { if (!rpc.receiveEnvelope(envelope)) events.push(envelope); },
    onClose: () => rpc?.rejectAll(new Error("Fixture viewer disconnected")),
  });
  rpc = new FederationRpcEndpoint({ localInstanceId: identity.id, remoteInstanceId: invite.gatewayInstanceId,
    sendEnvelope: (envelope) => connection.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
  connection.startReceiving();
  return { connection, identity, events, rpc,
    call: (method, params = {}) => rpc.request({ method: `backend.${method}`, params }),
    subscribe: (threadSelection = { kind: "all" }) => connection.sendEnvelope({ kind: "notification", id: randomUUID(), protocolVersion: 1,
      sourceInstanceId: identity.id, targetInstanceId: invite.gatewayInstanceId, createdAt: Date.now(), method: "federation.eventSubscription",
      params: { eventClasses: ["navigation", "transcript"], threadSelection } }),
  };
}

test("encrypted desktop protocol enrolls, browses, runs, reconnects and reads while owner remains alive", { timeout: 20000 }, async (t) => {
  const h = await setup(t);
  const issued = await h.rpc("federation-invite", { port: await port(), label: "Fixture outpost" });
  const invite = decodeFederationInvite(issued.invite);
  let v = await viewer(invite);
  t.after(() => v.connection.close());
  assert.ok((await v.call("listBackends")).backends[0].capabilities.startTurn);
  const created = await v.call("startThread", { backend: "codex", cwd: h.workspace, executionMode: "auto" });
  assert.equal(created.executionMode, "auto");
  const page = await v.call("getNavigationQueryPage", { protocol: 2, consumer: "remote-window", query: { kind: "lens", lens: "inbox" } });
  assert.equal(page.entries[0].row.ref.threadId, created.threadId);
  assert.equal(page.protocol, 2);
  const detail = await v.call("getNavigationSelectedDetail", { protocol: 2, ref: { backend: "codex", threadId: created.threadId } });
  assert.equal(detail.identity, "present");
  await v.call("startTurn", { backend: "codex", threadId: created.threadId, input: [{ type: "text", text: "hello" }] });
  v.connection.close();
  await eventually(() => {
    try { return readFileSync(path.join(h.workspace, "fixture-result.txt"), "utf8") === "hello"; } catch { return false; }
  });
  v = await viewer(invite, v.identity, "reconnect");
  const history = await v.call("readThread", { backend: "codex", threadId: created.threadId });
  assert.equal(history.replay.lastAssistantMessage, "Fixture result");
  assert.equal(v.events.length, 0, "no unsolicited transcript events");
  v.subscribe();
  const running = await v.call("startTurn", { backend: "codex", threadId: created.threadId, input: [{ type: "text", text: "slow" }] });
  await v.call("steerTurn", { backend: "codex", threadId: created.threadId, expectedTurnId: running.turnId, input: [{ type: "text", text: "steer" }] });
  const stopped = await v.call("controlActiveTurn", { backend: "codex", threadId: created.threadId, operation: "stop", requestId: "stop-1", expectedTurnId: running.turnId });
  assert.equal(stopped.disposition, "interrupted");
  await eventually(() => v.events.some((event) => event.method === "backend.event"));
  const persisted = JSON.parse(readFileSync(path.join(h.directory, "federation.json"), "utf8"));
  assert.equal(persisted.invites[0].status, "used");
  assert.ok(!JSON.stringify(persisted).includes(invite.token));
  await assert.rejects(viewer(invite), /missing_invite/);
  await h.rpc("federation-revoke", { peer: v.identity.id });
  await assert.rejects(viewer(invite, v.identity, "reconnect"), /revoked_peer/);
});

test("launchpad creation validates ownership and unsupported settings before creating a thread", { timeout: 20000 }, async (t) => {
  const h = await setup(t);
  const invite = decodeFederationInvite((await h.rpc("federation-invite", { port: await port() })).invite);
  const v = await viewer(invite);
  t.after(() => v.connection.close());
  const config = await v.call("getNavigationLaunchpadConfig", { protocol: 2, directoryKey: h.workspace });
  assert.equal(config.directoryKey, h.workspace);
  assert.equal(config.defaults.workMode, "local");
  assert.equal((await v.call("getNavigationLaunchpadConfig", { protocol: 2, directoryKey: h.workspace, knownRevision: config.revision })).unchanged, true);
  await assert.rejects(v.call("getNavigationLaunchpadConfig", { protocol: 2, directoryKey: "/outside" }), /not owned/);
  const params = { directoryKey: h.workspace, launchpad: { ...config.defaults, executionMode: "auto" } };
  for (const invalid of [
    { directoryKey: "/outside" }, { launchpad: { ...params.launchpad, workMode: "worktree" } },
    { launchpad: { ...params.launchpad, executionMode: "full-access" } },
    { launchpad: { ...params.launchpad, backend: "acp:fixture" } },
    { codexEnvironmentSelector: "production" }, { parentThreadId: "parent" },
    { input: [{ type: "image", url: "fixture" }] },
  ]) await assert.rejects(v.call("materializeDirectoryLaunchpad", { ...params, ...invalid }));
  assert.equal((await v.call("listThreads")).threads.length, 0, "unsupported requests cannot leave empty threads");
  const created = await v.call("materializeDirectoryLaunchpad", { ...params, input: [{ type: "text", text: "hello" }] });
  assert.equal(created.workMode, "local");
  assert.ok(created.turnId);
  assert.equal(created.turnStartFailure, undefined);
  await eventually(() => {
    try { return readFileSync(path.join(h.workspace, "fixture-result.txt"), "utf8") === "hello"; } catch { return false; }
  });
  const restricted = await viewer(decodeFederationInvite((await h.rpc("federation-invite", { port: Number(new URL(invite.gatewayUrl).port) })).invite), undefined, "enroll", ["thread_navigation"]);
  t.after(() => restricted.connection.close());
  await assert.rejects(restricted.call("materializeDirectoryLaunchpad", params), /capability|forbidden/i);
});

test("SCP-style invite import joins through an outbound SSH-forward equivalent, survives tunnel loss and rejoins", { timeout: 20000 }, async (t) => {
  const gateway = await setup(t);
  const outpost = await setup(t);
  const issued = await gateway.rpc("federation-invite", { port: await port() });
  const decoded = decodeFederationInvite(issued.invite);
  const destination = new URL(decoded.gatewayUrl);
  const sockets = new Set();
  let available = true;
  // A local byte forward models SSH's transport boundary without invoking an
  // operator SSH config, external CLI, real machine or provider.
  const proxy = net.createServer((socket) => {
    if (!available) { socket.destroy(); return; }
    const upstream = net.createConnection({ host: "127.0.0.1", port: Number(destination.port) });
    for (const stream of [socket, upstream]) {
      sockets.add(stream); stream.on("error", () => stream.destroy()); stream.on("close", () => sockets.delete(stream));
    }
    socket.pipe(upstream).pipe(socket);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
  const file = path.join(outpost.root, "copied-invite.txt");
  writeFileSync(file, issued.invite, { mode: 0o600 });
  const cli = outpost.launch(["federation-join", "--invite-file", file, "--gateway", `ws://127.0.0.1:${proxy.address().port}`, "--label", "Temporary outpost"]);
  assert.equal((await cli.done).code, 0, cli.errors);
  assert.equal(JSON.parse(cli.output).gateway.status, "connected");
  const before = await outpost.rpc("federation-status");
  assert.equal(before.lifecycle.kind, "outpost");
  assert.equal(before.lifecycle.role, "remote_agent");
  assert.equal(before.lifecycle.retainUntil, null);
  const peer = JSON.parse(readFileSync(path.join(gateway.directory, "federation.json"), "utf8")).peers[before.instanceId];
  assert.equal(peer.host.outpost.threadStorage, "owner");
  // A third peer talks to the owner through the gateway's actual router.
  const viewerInvite = decodeFederationInvite((await gateway.rpc("federation-invite", { port: Number(destination.port) })).invite);
  const v = await viewer(viewerInvite);
  t.after(() => v.connection.close());
  const remote = new FederationRpcEndpoint({ localInstanceId: v.identity.id, remoteInstanceId: before.instanceId,
    sendEnvelope: (envelope) => v.connection.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
  const originalReceive = v.rpc.receiveEnvelope.bind(v.rpc);
  v.rpc.receiveEnvelope = (envelope) => remote.receiveEnvelope(envelope) || originalReceive(envelope);
  assert.equal((await remote.request({ method: "backend.listBackends", params: {} })).backends[0].kind, "codex");
  v.connection.sendEnvelope({ kind: "notification", id: randomUUID(), protocolVersion: 1,
    sourceInstanceId: v.identity.id, targetInstanceId: before.instanceId, createdAt: Date.now(), method: "federation.eventSubscription",
    params: { eventClasses: ["navigation", "transcript"], eventClassSelections: { navigation: { kind: "all" } } } });
  await outpost.submit("detached-work", "hello");
  await eventually(() => v.events.some((event) => event.sourceInstanceId === before.instanceId && event.method === "backend.event"));
  assert.ok(v.events.filter((event) => event.method === "backend.event").every((event) => event.params.notification.method === "navigation/invalidated"), "class-specific demand never leaks transcript events");
  available = false;
  for (const socket of sockets) socket.destroy();
  assert.equal((await outpost.finished("detached-work")).status, "completed");
  await eventually(async () => (await outpost.rpc("federation-status")).gateway.status === "unreachable");
  available = true;
  await eventually(async () => (await outpost.rpc("federation-status")).gateway.status === "connected");
  assert.equal((await outpost.rpc("federation-status")).instanceId, before.instanceId);
  await outpost.stop(outpost.daemon);
  await outpost.start();
  await eventually(async () => (await outpost.rpc("federation-status")).gateway.status === "connected");
  assert.equal((await outpost.rpc("federation-status")).instanceId, before.instanceId);
  assert.equal((await outpost.rpc("show", { id: "detached-work" })).status, "completed");
});

test("ungranted mutation capabilities and wrong pinned keys fail closed", { timeout: 15000 }, async (t) => {
  const h = await setup(t);
  const invite = decodeFederationInvite((await h.rpc("federation-invite", { port: await port() })).invite);
  const v = await viewer(invite, undefined, "enroll", ["thread_navigation"]);
  t.after(() => v.connection.close());
  await assert.rejects(v.call("startThread", { backend: "codex" }), /capability/i);
  const second = decodeFederationInvite((await h.rpc("federation-invite", { port: Number(new URL(invite.gatewayUrl).port) })).invite);
  await assert.rejects(viewer({ ...second, gatewayPublicKeyPem: generateFederationIdentityKeyPair().publicKeyPem }), /Invalid federation auth challenge/);
  assert.equal(h.calls().filter((message) => message.method === "thread/start").length, 0);
  const limited = await viewer(second, undefined, "enroll", [...HEADLESS_CAPABILITIES, "durable_turn_requests_v1", "remote_pty"]);
  t.after(() => limited.connection.close());
  assert.deepEqual(limited.connection.capabilities, HEADLESS_CAPABILITIES);
  limited.connection.close();
  const reconnected = await viewer(second, limited.identity, "reconnect", [...HEADLESS_CAPABILITIES, "remote_pty"]);
  t.after(() => reconnected.connection.close());
  assert.deepEqual(reconnected.connection.capabilities, HEADLESS_CAPABILITIES);
});

for (const relay of [false, true]) {
  test(`event classes require their own grants over encrypted ${relay ? "relayed" : "direct"} connections`, { timeout: 20000 }, async (t) => {
    const gateway = await setup(t);
    const gatewayPort = await port();
    const issue = async () => decodeFederationInvite((await gateway.rpc("federation-invite", { port: gatewayPort })).invite);
    const invite = await issue();
    const owner = relay ? await setup(t) : gateway;
    if (relay) await owner.rpc("federation-join", { invite: (await gateway.rpc("federation-invite", { port: gatewayPort })).invite });
    const ownerId = (await owner.rpc("federation-status")).instanceId;
    const subscribers = [];
    for (const grants of [[], ["thread_navigation"], ["thread_detail"], ["thread_navigation", "thread_detail"]]) {
      const v = await viewer(subscribers.length ? await issue() : invite, undefined, "enroll", ["event_subscriptions", "gateway_relay", ...grants]);
      t.after(() => v.connection.close());
      const remote = new FederationRpcEndpoint({ localInstanceId: v.identity.id, remoteInstanceId: ownerId,
        sendEnvelope: (envelope) => v.connection.sendEnvelope(envelope), defaultTimeoutMs: 3000 });
      const originalReceive = v.rpc.receiveEnvelope.bind(v.rpc);
      v.rpc.receiveEnvelope = (envelope) => remote.receiveEnvelope(envelope) || originalReceive(envelope);
      v.connection.sendEnvelope({ kind: "notification", id: randomUUID(), protocolVersion: 1,
        sourceInstanceId: v.identity.id, targetInstanceId: ownerId, createdAt: Date.now(), method: "federation.eventSubscription",
        params: { eventClasses: ["navigation", "transcript", "unknown"], threadSelection: { kind: "all" },
          eventClassSelections: { navigation: { kind: "all" }, transcript: { kind: "all" } } } });
      // An RPC on the same stream fences the preceding subscription. A denied
      // read is also a response, without giving that subscriber extra grants.
      await remote.request({ method: "backend.listBackends", params: {} }).catch(() => {});
      subscribers.push({ v, grants, remote });
    }
    await owner.submit("private-conversation", "private conversation content");
    await owner.finished("private-conversation");
    await eventually(() => subscribers.at(-1).v.events.some((event) => event.params?.notification?.method === "turn/completed"));
    for (const { v, grants, remote } of subscribers) {
      await remote.request({ method: "backend.listBackends", params: {} }).catch(() => {});
      const notifications = v.events.filter((event) => event.method === "backend.event").map((event) => event.params.notification);
      const navigation = notifications.filter((event) => event.method === "navigation/invalidated");
      const transcript = notifications.filter((event) => event.method !== "navigation/invalidated");
      assert.equal(navigation.length > 0, grants.includes("thread_navigation"));
      assert.equal(transcript.some((event) => event.method === "turn/completed"), grants.includes("thread_detail"));
      if (!grants.includes("thread_detail")) assert.deepEqual(transcript, [], "subscription permission alone never grants conversation content");
    }
  });
}

test("leave removes the upstream router entry and subscriptions before asynchronous close", async () => {
  const id = randomUUID();
  let closed = false;
  let unregistered = false;
  const client = { close: () => { closed = true; } };
  const federation = Object.assign(Object.create(HeadlessFederation.prototype), {
    state: { instanceId: randomUUID(), gateway: { gatewayInstanceId: id } }, client,
    generation: 0, connections: new Map([[id, client]]), subscriptions: new Map([["viewer", { via: id }]]),
    router: { unregisterConnection: (peer) => { assert.equal(peer, id); unregistered = true; } }, save: () => {},
  });
  const status = await federation.leave();
  assert.equal(status.gateway, undefined);
  assert.deepEqual(status.peers, []);
  assert.equal(federation.subscriptions.size, 0);
  assert.equal(unregistered, true);
  assert.equal(closed, true);
});

for (const outcome of ["success", "failure"]) {
  test(`a superseded ${outcome} handshake releases the dial guard to the newly joined gateway`, { timeout: 20000 }, async (t) => {
    const first = await setup(t);
    const next = await setup(t);
    const outpost = await setup(t);
    const firstInvite = (await first.rpc("federation-invite", { port: await port() })).invite;
    const firstPort = Number(new URL(decodeFederationInvite(firstInvite).gatewayUrl).port);
    const nextInvite = (await next.rpc("federation-invite", { port: await port() })).invite;
    const sockets = new Set();
    const pending = [];
    let held = false;
    const proxy = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
      const forward = () => {
        const upstream = net.createConnection({ host: "127.0.0.1", port: firstPort });
        sockets.add(upstream);
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => sockets.delete(upstream));
        socket.pipe(upstream).pipe(socket);
      };
      if (held) pending.push({ socket, forward }); else forward();
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => { for (const socket of sockets) socket.destroy(); proxy.close(); });
    await outpost.rpc("federation-join", { invite: firstInvite, gateway: `ws://127.0.0.1:${proxy.address().port}` });
    held = true;
    for (const socket of sockets) socket.destroy();
    await eventually(() => pending.length > 0);
    assert.deepEqual((await outpost.rpc("federation-leave")).peers, []);
    await outpost.rpc("federation-join", { invite: nextInvite });
    for (const request of pending) {
      if (outcome === "success") request.forward(); else request.socket.destroy();
    }
    const connected = await eventually(async () => {
      const status = await outpost.rpc("federation-status");
      return status.gateway.status === "connected" ? status : null;
    });
    assert.equal(connected.gateway.instanceId, decodeFederationInvite(nextInvite).gatewayInstanceId);
    assert.deepEqual(connected.peers.map((peer) => peer.id), [connected.gateway.instanceId]);
    assert.deepEqual((await outpost.rpc("federation-leave")).peers, []);
  });
}
