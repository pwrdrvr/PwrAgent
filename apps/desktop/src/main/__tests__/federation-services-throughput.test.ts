// Service tunnel throughput harness. Off by default: it measures, it does not
// assert. Run it with
//   PWRAGENT_SERVICE_TUNNEL_BENCH=1 pnpm test apps/desktop/src/main/__tests__/federation-services-throughput.test.ts
// Each scenario writes one JSON line to stderr (vitest swallows console.log).
// PWRAGENT_SERVICE_TUNNEL_BENCH_FILTER narrows the matrix by a substring of the
// scenario name, such as "routed v1".
import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Session } from "node:inspector/promises";
import type { FederationCapability, FederationProtocolEnvelope, ServiceThread } from "@pwragent/shared";
import { FederationServices, registerFederationServices, SERVICE_METHOD_CAPABILITIES } from "../federation/federation-services";
import { FederationServiceForwarder } from "../federation/federation-service-forwarder";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FederationGatewayWebSocketServer, connectFederationClient } from "../federation/federation-transport";
import { FederationStore } from "../federation/federation-store";
import { generateFederationIdentityKeyPair } from "../federation/federation-identity";
import { generateNoiseStaticKeyPair, NoiseIKHandshake } from "../federation/federation-noise";
import { createFederationEnrollmentInvite } from "../federation/federation-enrollment";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const BENCH = process.env.PWRAGENT_SERVICE_TUNNEL_BENCH === "1";
const FILTER = process.env.PWRAGENT_SERVICE_TUNNEL_BENCH_FILTER ?? "";
const PROFILE = process.env.PWRAGENT_SERVICE_TUNNEL_BENCH_PROFILE === "1";
const thread: ServiceThread = { backend: "codex", threadId: "bench-thread" };
const MiB = 1024 * 1024;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

type Direction = "upload" | "download" | "duplex";
type Path = "routed" | "gateway";
type Fixture = { rpc: FederationRpcEndpoint; frames: () => number };

function report(line: Record<string, unknown>): void {
  process.stderr.write(`SERVICE_TUNNEL_BENCH ${JSON.stringify(line)}\n`);
}

/** Deliver after half the round trip. Equal delays keep FIFO order in Node's timer lists. */
function delayed(rttMs: number, deliver: () => void): void {
  if (rttMs <= 0) deliver();
  else setTimeout(deliver, rttMs / 2);
}

/** The viewer's RPC endpoint, owner router, and a relaying gateway router, in process. */
function routedFixture(service: FederationServices, rttMs: number): Fixture {
  const capabilities: FederationCapability[] = ["service_forward_v1", "gateway_relay"];
  const owner = new FederationRouter({ localInstanceId: "owner", methodCapabilities: SERVICE_METHOD_CAPABILITIES, trustedRelayPeerId: "gateway" });
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  let frames = 0;
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", defaultTimeoutMs: 30_000,
    sendEnvelope: (envelope) => { frames += 1; delayed(rttMs, () => { void gateway.routeEnvelope({ envelope, sourcePeerId: "viewer" }); }); } });
  owner.registerConnection({ peerId: "gateway", capabilities,
    sendEnvelope: (envelope) => { frames += 1; void gateway.routeEnvelope({ envelope, sourcePeerId: "owner" }); } });
  gateway.registerConnection({ peerId: "owner", capabilities, sendEnvelope: (envelope) => { void owner.routeEnvelope({ envelope, sourcePeerId: "gateway" }); } });
  gateway.registerConnection({ peerId: "viewer", capabilities,
    sendEnvelope: (envelope) => delayed(rttMs, () => { rpc.receiveEnvelope(envelope); }) });
  registerFederationServices(owner, service);
  cleanups.push(() => rpc.rejectAll(new Error("Bench complete")));
  return { rpc, frames: () => frames };
}

/** Two signed, Noise-encrypted, brotli-capable clients through a real gateway. */
async function gatewayFixture(service: FederationServices, rttMs: number): Promise<Fixture> {
  const db = openInMemoryStateDb();
  cleanups.push(() => db.close());
  const store = new FederationStore(db);
  const keys = generateFederationIdentityKeyPair();
  const noise = generateNoiseStaticKeyPair();
  const capabilities: FederationCapability[] = ["gateway_relay", "service_forward_v1", "transport_brotli"];
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const owner = new FederationRouter({ localInstanceId: "owner", trustedRelayPeerId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  registerFederationServices(owner, service);
  const server = new FederationGatewayWebSocketServer({
    gatewayInstanceId: "gateway", gatewayPrivateKeyPem: keys.privateKeyPem, gatewayPublicKeyPem: keys.publicKeyPem,
    host: "127.0.0.1", port: 0, store, noiseStatic: noise, compressionEnabled: true,
    onConnection: (connection) => gateway.registerConnection(connection),
    onDisconnect: (connection) => { gateway.unregisterConnection(connection.peerId); },
    onEnvelope: (envelope, connection) => { void gateway.routeEnvelope({ envelope, sourcePeerId: connection.peerId }); },
  });
  const { url } = await server.start();
  cleanups.push(() => server.stop());
  const clients = new Map<string, Awaited<ReturnType<typeof connectFederationClient>>>();
  let frames = 0;
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", defaultTimeoutMs: 30_000,
    sendEnvelope: (envelope) => { frames += 1; delayed(rttMs, () => clients.get("viewer")!.sendEnvelope(envelope)); } });
  cleanups.push(() => rpc.rejectAll(new Error("Bench complete")));
  for (const peerId of ["owner", "viewer"]) {
    const identity = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({ store, token: `bench-${peerId}`, gatewayInstanceId: "gateway",
      generatedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const client = await connectFederationClient({
      url, mode: "enroll", gatewayInstanceId: "gateway", gatewayPublicKeyPem: keys.publicKeyPem,
      privateKeyPem: identity.privateKeyPem, publicKeyPem: identity.publicKeyPem, peerInstanceId: peerId,
      role: "client", capabilities, inviteToken: invite.token, noiseStatic: generateNoiseStaticKeyPair(), gatewayNoisePublicKey: noise.publicKeyRaw,
      onEnvelope: (envelope: FederationProtocolEnvelope) => {
        if (peerId === "owner") void owner.routeEnvelope({ envelope, sourcePeerId: "gateway" });
        else delayed(rttMs, () => { rpc.receiveEnvelope(envelope); });
      },
    });
    clients.set(peerId, client);
    cleanups.push(() => client.close());
  }
  owner.registerConnection({ peerId: "gateway", capabilities,
    sendEnvelope: (envelope) => { frames += 1; clients.get("owner")!.sendEnvelope(envelope); } });
  return { rpc, frames: () => frames };
}

/** Write until stopped, honoring the socket's own backpressure. */
function flood(socket: Socket, chunk: Buffer): () => void {
  let stopped = false;
  const pump = (): void => {
    while (!stopped && !socket.destroyed) {
      if (!socket.write(chunk)) { socket.once("drain", pump); return; }
    }
  };
  pump();
  return () => { stopped = true; };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

async function measure(params: { path: Path; rttMs: number; direction: Direction; seconds: number }): Promise<Record<string, unknown>> {
  const chunk = randomBytes(64 * 1024);
  const counts = { up: 0, down: 0 };
  const serverSockets = new Set<Socket>();
  const stops: Array<() => void> = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    serverSockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("data", (data: Buffer) => { counts.up += data.length; });
    if (params.direction !== "upload") stops.push(flood(socket, chunk));
  });
  const port = await listen(server);
  cleanups.push(() => { for (const socket of serverSockets) socket.destroy(); });
  const service = new FederationServices({ instanceId: "owner", allowForwarding: () => true, threadExists: async () => true });
  cleanups.push(() => service.dispose());
  const declaration = await service.advertise(thread, { port, name: "bench", protocol: "tcp" });
  const fixture = params.path === "routed" ? routedFixture(service, params.rttMs) : await gatewayFixture(service, params.rttMs);
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const forward = await forwarder.connect(1, declaration, fixture.rpc);
  const client = connect({ host: "127.0.0.1", port: forward.localPort, allowHalfOpen: true });
  cleanups.push(() => { client.destroy(); });
  client.on("error", () => undefined);
  await once(client, "connect");
  client.on("data", (data: Buffer) => { counts.down += data.length; });
  if (params.direction !== "download") stops.push(flood(client, chunk));
  // Warm up past stream open and the first round trips.
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(300, params.rttMs * 4)));
  const session = PROFILE ? new Session() : undefined;
  if (session) { session.connect(); await session.post("Profiler.enable"); await session.post("Profiler.start"); }
  const start = { ...counts, frames: fixture.frames(), cpu: process.cpuUsage(), at: performance.now() };
  await new Promise<void>((resolve) => setTimeout(resolve, params.seconds * 1000));
  const hot = session ? topSelfTime((await session.post("Profiler.stop")).profile) : undefined;
  session?.disconnect();
  const cpu = process.cpuUsage(start.cpu);
  const elapsed = (performance.now() - start.at) / 1000;
  const up = counts.up - start.up;
  const down = counts.down - start.down;
  for (const stop of stops) stop();
  const movedMiB = (up + down) / MiB;
  return {
    upMiBps: +(up / MiB / elapsed).toFixed(3),
    downMiBps: +(down / MiB / elapsed).toFixed(3),
    cpuMsPerMiB: movedMiB > 0 ? +(((cpu.user + cpu.system) / 1000) / movedMiB).toFixed(2) : null,
    cpuShare: +(((cpu.user + cpu.system) / 1e6) / elapsed).toFixed(3),
    viewerFramesPerMiB: movedMiB > 0 ? +((fixture.frames() - start.frames) / movedMiB).toFixed(1) : null,
    ...(hot ? { hot } : {}),
  };
}

type CpuProfile = { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples?: number[]; timeDeltas?: number[] };
/** Self time by function, as a share of all samples, for the 20 hottest. */
function topSelfTime(profile: CpuProfile): string[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const totals = new Map<string, number>();
  let all = 0;
  (profile.samples ?? []).forEach((id, index) => {
    const delta = profile.timeDeltas?.[index] ?? 0;
    const frame = byId.get(id)?.callFrame;
    const key = frame ? `${frame.functionName || "(anon)"} ${frame.url.split("/").slice(-2).join("/")}:${frame.lineNumber + 1}` : "?";
    totals.set(key, (totals.get(key) ?? 0) + delta);
    all += delta;
  });
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([key, time]) => `${(100 * time / all).toFixed(1)}% ${key}`);
}

function codecMicrobench(): Record<string, unknown> {
  const chunkBytes = 16 * 1024;
  const iterations = 512; // 8 MiB per cell
  const handshake = (): { send: ReturnType<NoiseIKHandshake["split"]>; receive: ReturnType<NoiseIKHandshake["split"]> } => {
    const gateway = generateNoiseStaticKeyPair();
    const initiator = new NoiseIKHandshake({ role: "initiator", localStatic: generateNoiseStaticKeyPair(), remoteStaticPublicKey: gateway.publicKeyRaw });
    const responder = new NoiseIKHandshake({ role: "responder", localStatic: gateway });
    responder.readMessage1(initiator.writeMessage1(Buffer.alloc(0)));
    initiator.readMessage2(responder.writeMessage2(Buffer.alloc(0)));
    return { send: initiator.split(), receive: responder.split() };
  };
  const text = Buffer.from("<div class=\"row\">const value = compute(index);</div>\n".repeat(400)).subarray(0, chunkBytes);
  const result: Record<string, unknown> = {};
  for (const [kind, data] of [["random", randomBytes(chunkBytes)], ["text", text]] as const) {
    const cell = (label: string, run: () => void): void => {
      const before = process.cpuUsage();
      for (let i = 0; i < iterations; i += 1) run();
      const used = process.cpuUsage(before);
      result[`${kind}.${label}`] = +(((used.user + used.system) / 1000) / (iterations * chunkBytes / MiB)).toFixed(3);
    };
    const base64 = data.toString("base64");
    const json = Buffer.from(JSON.stringify({ kind: "envelope", envelope: { id: "x", kind: "request", method: "services.v1.exchange", params: { streamId: "s", seq: 1, data: base64, fin: false, receive: true } } }));
    const compressed = brotliCompressSync(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } });
    const noise = handshake();
    cell("base64Encode", () => { data.toString("base64"); });
    cell("base64DecodeValidated", () => { Buffer.from(base64, "base64").toString("base64"); });
    cell("jsonStringify", () => { Buffer.from(JSON.stringify({ params: { data: base64 } })); });
    cell("jsonParse", () => { JSON.parse(json.toString("utf8")); });
    cell("brotliQ1Compress", () => { brotliCompressSync(json, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } }); });
    cell("brotliDecompress", () => { brotliDecompressSync(compressed); });
    cell("noiseEncryptDecrypt", () => { noise.receive.decrypt(noise.send.encrypt(json)); });
    result[`${kind}.brotliRatio`] = +(compressed.length / json.length).toFixed(3);
  }
  return result;
}

describe.skipIf(!BENCH)("service tunnel throughput (measurement only)", () => {
  it("measures the codec cost per MiB", () => {
    report({ scenario: "codec cpu ms per MiB, 16 KiB chunks", ...codecMicrobench() });
  });

  const matrix: Array<{ path: Path; rttMs: number }> = [
    { path: "routed", rttMs: 0 }, { path: "routed", rttMs: 1 }, { path: "routed", rttMs: 20 },
    { path: "routed", rttMs: 50 }, { path: "routed", rttMs: 200 },
    { path: "gateway", rttMs: 0 }, { path: "gateway", rttMs: 20 },
  ];
  for (const { path, rttMs } of matrix) {
    for (const direction of ["upload", "download", "duplex"] as const) {
      const scenario = `${path} v1 rtt=${rttMs}ms ${direction}`;
      it.skipIf(FILTER !== "" && !scenario.includes(FILTER))(scenario, async () => {
        const seconds = rttMs >= 50 ? 4 : 2;
        const line = await measure({ path, rttMs, direction, seconds });
        report({ scenario, path, protocol: 1, rttMs, direction, seconds, ...line });
        expect(line).toBeDefined();
      }, 60_000);
    }
  }
});
