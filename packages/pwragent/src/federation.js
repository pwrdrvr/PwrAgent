import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { hostname, arch, platform, release } from "node:os";
import path from "node:path";
import {
  connectFederationClient, FederationGatewayWebSocketServer, FederationRouter,
  generateFederationIdentityKeyPair, generateFederationNoiseStaticKeyPair,
  noiseKeyPairFromRawPrivate, decodeFederationInvite, encodeFederationInvite,
  FEDERATION_PROTOCOL_VERSION, FEDERATION_INVITE_VERSION,
} from "../dist/federation-core.js";
import { atomicJson } from "./store.js";
import { HeadlessBackend, METHOD_CAPABILITIES } from "./federation-backend.js";

export const HEADLESS_CAPABILITIES = ["remote_window", "thread_navigation", "thread_detail", "turn_control", "event_subscriptions", "gateway_relay", "transport_brotli"];

function forwardEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash
    || (url.protocol !== "wss:" && !(url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) {
    throw new Error("Gateway must be a loopback ws:// forward or a wss:// endpoint without credentials");
  }
  return url.toString();
}

/** Identity persists independently of compute/tunnel presence. No VM API calls. */
export class HeadlessFederation {
  constructor({ directory, runtime, profile, onFailure }) {
    this.file = path.join(directory, "federation.json");
    this.runtime = runtime;
    this.profile = profile;
    this.onFailure = onFailure;
    this.connections = new Map();
    this.subscriptions = new Map();
    this.retryDelay = 1000;
    this.generation = 0;
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error("Federation identity file must be private and owned by this user");
      this.state = JSON.parse(readFileSync(this.file, "utf8"));
      if (this.state.version !== 1 || !this.state.instanceId || !this.state.identity?.privateKeyPem || !this.state.noise?.privateKeyBase64) throw new Error("Invalid federation identity file");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    this.backend = new HeadlessBackend(runtime, (event, eventClass) => this.publish(event, eventClass));
    runtime.onEvent = (message) => this.backend.event(message);
  }

  save() {
    try { atomicJson(this.file, this.state); } catch (error) { this.onFailure(error); throw error; }
  }

  ensureIdentity(label) {
    if (label !== undefined && (typeof label !== "string" || !label.trim() || label.length > 200)) throw new Error("Label must be 1–200 characters");
    if (this.state) return;
    this.state = { version: 1, instanceId: randomUUID(), label: label || `${hostname()} outpost`,
      identity: generateFederationIdentityKeyPair(), noise: generateFederationNoiseStaticKeyPair(),
      hmacKey: randomBytes(32).toString("hex"), peers: {}, invites: [],
      lifecycle: { kind: "outpost", role: "remote_agent", persistence: "unknown", retainUntil: null, threadStorage: "owner" } };
    this.save();
  }

  setupRouter() {
    this.router = new FederationRouter({ localInstanceId: this.state.instanceId,
      trustedRelayPeerId: () => this.state.gateway?.gatewayInstanceId, methodCapabilities: METHOD_CAPABILITIES });
    for (const method of Object.keys(METHOD_CAPABILITIES)) {
      this.router.registerHandler(method, (envelope) => this.backend.handle(method, envelope.params, envelope));
    }
  }

  async start() {
    if (!this.state) return;
    this.stopping = false;
    if (!this.router) this.setupRouter();
    if (this.state.listenPort !== undefined) await this.listen(this.state.listenPort);
    if (this.state.gateway) void this.connect();
  }

  host() {
    return { hostname: hostname(), platform: platform(), osVersion: release(), arch: arch(),
      machineId: this.state.instanceId, outpost: this.state.lifecycle };
  }

  status() {
    return { enabled: Boolean(this.state), instanceId: this.state?.instanceId,
      label: this.state?.label, lifecycle: this.state?.lifecycle, listener: this.listenerAddress,
      gateway: this.state?.gateway ? { instanceId: this.state.gateway.gatewayInstanceId,
        endpoint: this.state.gateway.endpoint, status: this.client ? "connected" : "unreachable", error: this.connectionError } : undefined,
      peers: [...this.connections.keys()].map((id) => ({ id, status: "connected" })) };
  }

  async join({ invite, gateway, label }) {
    if (this.state?.gateway) throw new Error("This outpost already has a gateway; use federation-leave before importing another invite");
    const decoded = decodeFederationInvite(invite);
    const endpoint = forwardEndpoint(gateway || decoded.gatewayUrl);
    this.ensureIdentity(label);
    this.state.gateway = { ...decoded, endpoint };
    this.save();
    if (!this.router) this.setupRouter();
    await this.connect();
    return this.status();
  }

  async invite({ port = 47831, label }) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Federation port must be between 1 and 65535");
    this.ensureIdentity(label);
    if (!this.router) this.setupRouter();
    if (this.state.listenPort !== undefined && this.state.listenPort !== port) throw new Error("Restart with the existing listener port; it cannot change while serving");
    await this.listen(port);
    this.state.listenPort = port;
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const entry = { id: randomUUID(), status: "pending", generatedAt: now, expiresAt: now + 15 * 60_000,
      gatewayInstanceId: this.state.instanceId, tokenHash: this.hashToken(token) };
    this.state.invites = this.state.invites.filter((item) => item.status === "pending" && item.expiresAt > now).slice(-15);
    this.state.invites.push(entry);
    this.save();
    return { invite: encodeFederationInvite({ version: FEDERATION_INVITE_VERSION, token,
      gatewayInstanceId: this.state.instanceId, gatewayPublicKeyPem: this.state.identity.publicKeyPem,
      gatewayNoisePublicKey: this.state.noise.publicKeyBase64, gatewayUrl: this.listenerAddress.url, expiresAt: entry.expiresAt }),
    expiresAt: entry.expiresAt, instanceId: this.state.instanceId };
  }

  hashToken(token) { return createHmac("sha256", this.state.hmacKey).update(token).digest("hex"); }

  store() {
    return {
      getPeer: (id) => this.state.peers[id],
      upsertPeer: ({ peer, clearRevocation }) => {
        const existing = this.state.peers[peer.id];
        this.state.peers[peer.id] = existing?.revokedAt && !clearRevocation ? { ...peer, status: "revoked", revokedAt: existing.revokedAt } : peer;
        this.save();
      },
      findMatchingPendingEnrollment: ({ token, now }) => this.state.invites.find((entry) => entry.status === "pending" && entry.expiresAt > now
        && timingSafeEqual(Buffer.from(entry.tokenHash, "hex"), Buffer.from(this.hashToken(token), "hex"))),
      markEnrollmentUsed: ({ enrollmentId, peerId, usedAt }) => {
        const entry = this.state.invites.find((item) => item.id === enrollmentId);
        if (!entry || entry.status !== "pending") return undefined;
        Object.assign(entry, { status: "used", peerId, usedAt });
        this.save();
        return entry;
      },
      appendAudit: (entry) => ({ ...entry, eventId: 0 }),
    };
  }

  async listen(port) {
    if (this.listener) return;
    this.listener = new FederationGatewayWebSocketServer({ gatewayInstanceId: this.state.instanceId,
      gatewayPrivateKeyPem: this.state.identity.privateKeyPem, gatewayPublicKeyPem: this.state.identity.publicKeyPem,
      noiseStatic: noiseKeyPairFromRawPrivate(Buffer.from(this.state.noise.privateKeyBase64, "base64")),
      host: "127.0.0.1", port, store: this.store(),
      supportedCapabilities: HEADLESS_CAPABILITIES,
      onConnection: (connection) => this.register(connection.peerId, connection.capabilities, connection),
      onDisconnect: (connection) => this.unregister(connection.peerId, connection),
      onEnvelope: (envelope, connection) => this.receive(envelope, connection.peerId),
    });
    try { this.listenerAddress = await this.listener.start(); } catch (error) { this.listener = null; throw error; }
  }

  async connect() {
    const gateway = this.state?.gateway;
    if (this.stopping || !gateway || this.connecting || this.client) return;
    this.connecting = true;
    const generation = this.generation;
    const dial = async (mode) => {
      let connection;
      connection = await connectFederationClient({ url: gateway.endpoint, mode,
      gatewayInstanceId: gateway.gatewayInstanceId, gatewayPublicKeyPem: gateway.gatewayPublicKeyPem,
      gatewayNoisePublicKey: Buffer.from(gateway.gatewayNoisePublicKey, "base64"),
      noiseStatic: noiseKeyPairFromRawPrivate(Buffer.from(this.state.noise.privateKeyBase64, "base64")),
      peerInstanceId: this.state.instanceId, ...this.state.identity, capabilities: HEADLESS_CAPABILITIES,
      inviteToken: mode === "enroll" ? gateway.token : undefined, label: this.state.label,
      role: this.listener ? "dual" : "client", profileName: this.profile,
      notes: "Headless outpost: retained identity; tunnel loss does not stop work or imply deletion.", host: this.host(),
      deferReceiving: true, connectTimeoutMs: 5000,
      onEnvelope: (envelope) => this.receive(envelope, gateway.gatewayInstanceId),
      onClose: (info) => {
        if (!connection || this.client !== connection) return;
        this.unregister(gateway.gatewayInstanceId, connection);
        this.client = null;
        if (info?.code === 4002 || info?.code === 4001) {
          this.connectionError = info.code === 4002 ? "revoked_peer" : "identity_in_use";
          return;
        }
        this.schedule();
      },
      });
      return connection;
    };
    try {
      let client;
      // Enrollment may already have succeeded before its acknowledgment was
      // persisted. Reconnect first, so a consumed one-time token is not reused.
      try { client = await dial("reconnect"); } catch (error) {
        if (error.message !== "unknown_peer" || !gateway.token || gateway.expiresAt <= Date.now()) throw error;
        client = await dial("enroll");
      }
      if (this.stopping || generation !== this.generation) { client.close(); return; }
      this.client = client;
      if (gateway.token) { delete gateway.token; this.save(); }
      this.connectionError = undefined;
      this.retryDelay = 1000;
      this.register(gateway.gatewayInstanceId, client.capabilities, client);
      client.startReceiving();
    } catch (error) {
      this.connectionError = ["revoked_peer", "unknown_peer", "missing_invite"].includes(error.message) ? error.message : "connection_failed";
      if (this.connectionError === "connection_failed") this.schedule();
    } finally { this.connecting = false; }
  }

  schedule() {
    if (this.stopping || !this.state?.gateway || this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.connect(); }, this.retryDelay);
    this.retryDelay = Math.min(30000, this.retryDelay * 2);
  }

  register(id, capabilities, connection) {
    this.connections.set(id, connection);
    this.router.registerConnection({ peerId: id, capabilities, sendEnvelope: (envelope) => connection.sendEnvelope(envelope) });
  }

  unregister(id, connection) {
    if (this.connections.get(id) !== connection) return;
    this.connections.delete(id);
    this.router.unregisterConnection(id);
    for (const [subscriber, subscription] of this.subscriptions) {
      if (subscription.via === id) this.subscriptions.delete(subscriber);
    }
  }

  receive(envelope, peerId) {
    if (envelope.kind === "notification" && envelope.method === "federation.eventSubscription" && envelope.targetInstanceId === this.state.instanceId) {
      if (envelope.sourceInstanceId !== peerId && (peerId !== this.state.gateway?.gatewayInstanceId || !(envelope.hopCount >= 1))) return;
      if (!this.router.getConnection(peerId)?.capabilities.includes("event_subscriptions")) return;
      if (this.subscriptions.size >= 128 && !this.subscriptions.has(envelope.sourceInstanceId)) return;
      const subscription = envelope.params;
      const validSelection = (selection) => selection?.kind === "all" || (selection?.kind === "threads"
        && Array.isArray(selection.threads) && selection.threads.length <= 100
        && selection.threads.every((thread) => thread.backend === "codex" && typeof thread.threadId === "string"));
      if (!Array.isArray(subscription?.eventClasses) || subscription.eventClasses.length > 16
        || (subscription.threadSelection !== undefined && !validSelection(subscription.threadSelection))
        || (subscription.eventClassSelections && !Object.values(subscription.eventClassSelections).every(validSelection))) return;
      this.subscriptions.set(envelope.sourceInstanceId, { ...subscription, threadSelection: subscription.threadSelection || { kind: "all" }, via: peerId });
      return;
    }
    void this.router.routeEnvelope({ envelope, sourcePeerId: peerId }).catch(() => { /* Transport shutdown can race a response. */ });
  }

  publish(event, eventClass = "transcript") {
    for (const [subscriber, subscription] of this.subscriptions) {
      if (!subscription.eventClasses?.includes(eventClass)) continue;
      const selection = subscription.eventClassSelections ? subscription.eventClassSelections[eventClass] : subscription.threadSelection;
      const threadId = event.notification.params?.threadId || event.notification.params?.thread?.id;
      if (selection?.kind !== "all" && !selection?.threads?.some((thread) => thread.backend === "codex" && thread.threadId === threadId)) continue;
      try { this.connections.get(subscription.via)?.sendEnvelope({ kind: "notification", method: "backend.event",
        params: event, id: randomUUID(), protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.state.instanceId, targetInstanceId: subscriber, createdAt: Date.now() }); } catch { /* Reconnect reestablishes demand; no job is cancelled. */ }
    }
  }

  async leave() {
    this.generation++;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.state) { delete this.state.gateway; this.save(); }
    this.client?.close();
    this.client = null;
    return this.status();
  }

  revoke(id) {
    const peer = this.state?.peers[id];
    if (!peer) throw new Error("Unknown enrolled peer");
    peer.status = "revoked";
    peer.revokedAt = Date.now();
    this.save();
    this.listener?.closePeer(id);
    return { revoked: id };
  }

  async stop() {
    this.stopping = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.client?.close();
    await this.listener?.stop();
  }
}
