// Service tunnel throughput harness. Off by default: it measures, it does not
// assert. Run it with
//   PWRAGENT_SERVICE_TUNNEL_BENCH=1 pnpm test apps/desktop/src/main/__tests__/federation-services-throughput.test.ts
// Each scenario writes one JSON line to stderr (vitest swallows console.log).
// PWRAGENT_SERVICE_TUNNEL_BENCH_FILTER narrows the matrix by a substring of the
// scenario name, such as "routed v1". Scenarios marked "text" send compressible
// text instead of random bytes.
import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, connect, type AddressInfo, type Server, type Socket } from "node:net";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";
import { randomBytes } from "node:crypto";
import { Session } from "node:inspector/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type {
  FederationCapability, FederationNotificationEnvelope, FederationProtocolEnvelope, FederationServiceDataEnvelope,
  ServiceStreamData, ServiceThread,
} from "@pwragent/shared";
import { FederationServices, registerFederationServices, SERVICE_METHOD_CAPABILITIES } from "../federation/federation-services";
import { FederationServiceForwarder } from "../federation/federation-service-forwarder";
import { serviceDataEnvelope } from "../federation/federation-service-stream";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import {
  FederationGatewayWebSocketServer, connectFederationClient, federationTransportCodecForTest,
} from "../federation/federation-transport";
import { FederationStore } from "../federation/federation-store";
import { encodeFederationFramePayload } from "../federation/federation-frame-codec";
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
type Path = "routed" | "gateway" | "gateway-plain";
type Payload = "random" | "text";
type Fixture = { rpc: FederationRpcEndpoint; frames: () => number };

function report(line: Record<string, unknown>): void {
  process.stderr.write(`SERVICE_TUNNEL_BENCH ${JSON.stringify(line)}\n`);
}

/** Deliver after half the round trip. Equal delays keep FIFO order in Node's timer lists. */
function delayed(rttMs: number, deliver: () => void): void {
  if (rttMs <= 0) deliver();
  else setTimeout(deliver, rttMs / 2);
}

function notification(source: string, target: string, method: string, params: unknown): FederationNotificationEnvelope {
  return { id: `bench:${Math.random()}`, kind: "notification", method, params, protocolVersion: 1, sourceInstanceId: source, targetInstanceId: target, createdAt: Date.now() };
}

function serviceData(source: string, target: string, frame: ServiceStreamData): FederationServiceDataEnvelope {
  return serviceDataEnvelope(frame, { id: `bench:${Math.random()}`, sourceInstanceId: source, targetInstanceId: target, createdAt: Date.now() });
}

/** Owner-to-viewer delivery: windowed frames to the forwarder, the rest to the RPC endpoint. */
function viewerReceiver(rpc: FederationRpcEndpoint, forwarder: FederationServiceForwarder) {
  return (envelope: FederationProtocolEnvelope): void => {
    if (envelope.kind === "notification") forwarder.receiveNotification(envelope.sourceInstanceId, envelope.method, envelope.params);
    else if (envelope.kind === "service_data") forwarder.receiveData(envelope.sourceInstanceId, envelope);
    else rpc.receiveEnvelope(envelope);
  };
}

const CAPABILITIES: FederationCapability[] = ["service_forward_v1", "service_forward_v2", "gateway_relay"];

/** The viewer's RPC endpoint, owner router, and a relaying gateway router, in process. */
function routedFixture(service: FederationServices, forwarder: FederationServiceForwarder, rttMs: number): Fixture {
  const capabilities = CAPABILITIES;
  const owner = new FederationRouter({ localInstanceId: "owner", methodCapabilities: SERVICE_METHOD_CAPABILITIES, trustedRelayPeerId: "gateway" });
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  let frames = 0;
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", defaultTimeoutMs: 30_000,
    sendEnvelope: (envelope) => { frames += 1; delayed(rttMs, () => { void gateway.routeEnvelope({ envelope, sourcePeerId: "viewer" }); }); } });
  const toViewer = viewerReceiver(rpc, forwarder);
  owner.registerConnection({ peerId: "gateway", capabilities,
    sendEnvelope: (envelope) => { frames += 1; void gateway.routeEnvelope({ envelope, sourcePeerId: "owner" }); } });
  gateway.registerConnection({ peerId: "owner", capabilities, sendEnvelope: (envelope) => { void owner.routeEnvelope({ envelope, sourcePeerId: "gateway" }); } });
  gateway.registerConnection({ peerId: "viewer", capabilities, sendEnvelope: (envelope) => delayed(rttMs, () => toViewer(envelope)) });
  registerFederationServices(owner, service, { link: {
    notify: (peerId, method, params) => { owner.sendToPeer("gateway", notification("owner", peerId, method, params)); },
    sendData: (peerId, frame) => { owner.sendToPeer("gateway", serviceData("owner", peerId, frame)); },
  } });
  cleanups.push(() => rpc.rejectAll(new Error("Bench complete")));
  return { rpc, frames: () => frames };
}

/** Two signed, Noise-encrypted clients through a real gateway, with or without brotli. */
async function gatewayFixture(service: FederationServices, forwarder: FederationServiceForwarder, rttMs: number, compression: boolean): Promise<Fixture> {
  const db = openInMemoryStateDb();
  cleanups.push(() => db.close());
  const store = new FederationStore(db);
  const keys = generateFederationIdentityKeyPair();
  const noise = generateNoiseStaticKeyPair();
  const capabilities: FederationCapability[] = [...CAPABILITIES, ...(compression ? ["transport_brotli" as const] : [])];
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const owner = new FederationRouter({ localInstanceId: "owner", trustedRelayPeerId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const server = new FederationGatewayWebSocketServer({
    gatewayInstanceId: "gateway", gatewayPrivateKeyPem: keys.privateKeyPem, gatewayPublicKeyPem: keys.publicKeyPem,
    host: "127.0.0.1", port: 0, store, noiseStatic: noise, compressionEnabled: compression,
    onConnection: (connection) => gateway.registerConnection(connection),
    onDisconnect: (connection) => { gateway.unregisterConnection(connection.peerId); },
    onEnvelope: (envelope, connection) => { void gateway.routeEnvelope({ envelope, sourcePeerId: connection.peerId }); },
  });
  const { url } = await server.start();
  cleanups.push(() => server.stop());
  const clients = new Map<string, Awaited<ReturnType<typeof connectFederationClient>>>();
  let frames = 0;
  const viewerSend = (envelope: FederationProtocolEnvelope): void | Promise<void> => {
    frames += 1;
    const client = clients.get("viewer")!;
    if (rttMs <= 0) return client.sendEnvelopeWithBackpressure!(envelope);
    delayed(rttMs, () => client.sendEnvelope(envelope));
  };
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner", defaultTimeoutMs: 30_000,
    sendEnvelope: (envelope) => { frames += 1; delayed(rttMs, () => clients.get("viewer")!.sendEnvelope(envelope)); },
    sendOneWay: viewerSend });
  const toViewer = viewerReceiver(rpc, forwarder);
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
        else delayed(rttMs, () => toViewer(envelope));
      },
    });
    clients.set(peerId, client);
    cleanups.push(() => client.close());
  }
  owner.registerConnection({ peerId: "gateway", capabilities,
    sendEnvelope: (envelope) => { frames += 1; clients.get("owner")!.sendEnvelope(envelope); } });
  const ownerSend = (envelope: FederationProtocolEnvelope): Promise<void> => {
    frames += 1;
    return clients.get("owner")!.sendEnvelopeWithBackpressure!(envelope);
  };
  registerFederationServices(owner, service, { link: {
    notify: (peerId, method, params) => ownerSend(notification("owner", peerId, method, params)),
    sendData: (peerId, frame) => ownerSend(serviceData("owner", peerId, frame)),
  } });
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

/** Dev-server-like text: compresses about 4:1 at brotli quality 1. */
function textChunk(bytes: number): Buffer {
  let text = "";
  for (let index = 0; text.length < bytes; index += 1) {
    text += `export const value${index} = compute(${index * 7919 % 1000}, "row-${index % 97}");\n`;
  }
  return Buffer.from(text).subarray(0, bytes);
}

async function measure(params: { path: Path; protocol: 1 | 2; rttMs: number; direction: Direction; seconds: number; payload: Payload }): Promise<Record<string, unknown>> {
  const chunk = params.payload === "text" ? textChunk(64 * 1024) : randomBytes(64 * 1024);
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
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const fixture = params.path === "routed" ? routedFixture(service, forwarder, params.rttMs)
    : await gatewayFixture(service, forwarder, params.rttMs, params.path === "gateway");
  const forward = await forwarder.connect(1, declaration, fixture.rpc, { streams: params.protocol });
  const client = connect({ host: "127.0.0.1", port: forward.localPort, allowHalfOpen: true });
  cleanups.push(() => { client.destroy(); });
  client.on("error", () => undefined);
  await once(client, "connect");
  client.on("data", (data: Buffer) => { counts.down += data.length; });
  if (params.direction !== "download") stops.push(flood(client, chunk));
  // Warm up past stream open and the first round trips.
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(300, params.rttMs * 4)));
  const session = PROFILE ? new Session() : undefined;
  if (session) { session.connect(); await session.post("Profiler.enable"); await session.post("Profiler.setSamplingInterval", { interval: 100 }); await session.post("Profiler.start"); }
  const threadsBefore = PROFILE ? threadTicks() : undefined;
  const start = { ...counts, frames: fixture.frames(), cpu: process.cpuUsage(), at: performance.now() };
  await new Promise<void>((resolve) => setTimeout(resolve, params.seconds * 1000));
  const hot = session ? topSelfTime((await session.post("Profiler.stop")).profile) : undefined;
  session?.disconnect();
  const threads = threadsBefore ? threadTickDelta(threadsBefore, threadTicks()) : undefined;
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
    framesPerMiB: movedMiB > 0 ? +((fixture.frames() - start.frames) / movedMiB).toFixed(1) : null,
    ...(hot ? { hot } : {}),
    ...(threads ? { threads } : {}),
  };
}

/** Linux only: user+system clock ticks per thread of this process. */
function threadTicks(): Map<string, number> {
  const ticks = new Map<string, number>();
  if (!existsSync("/proc/self/task")) return ticks;
  for (const tid of readdirSync("/proc/self/task")) {
    try {
      const stat = readFileSync(`/proc/self/task/${tid}/stat`, "utf8");
      const name = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks.set(`${tid}:${name}`, Number(fields[11]) + Number(fields[12]));
    } catch { /* thread exited */ }
  }
  return ticks;
}
function threadTickDelta(before: Map<string, number>, after: Map<string, number>): string[] {
  return [...after.entries()].map(([key, value]) => [key, value - (before.get(key) ?? 0)] as const)
    .filter(([, delta]) => delta > 0).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([key, delta]) => `${delta} ${key}`);
}

type CpuProfile = { nodes: Array<{ id: number; children?: number[]; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples?: number[]; timeDeltas?: number[] };
/** Self time by function, as a share of busy (non-idle) samples, for the 25 hottest. */
function topSelfTime(profile: CpuProfile): string[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
  const label = (id: number | undefined): string => {
    const frame = id === undefined ? undefined : byId.get(id)?.callFrame;
    return frame ? `${frame.functionName || "(anon)"} ${frame.url.split("/").slice(-2).join("/")}:${frame.lineNumber + 1}` : "?";
  };
  const totals = new Map<string, number>();
  let all = 0;
  (profile.samples ?? []).forEach((id, index) => {
    const delta = profile.timeDeltas?.[index] ?? 0;
    const frame = byId.get(id)?.callFrame;
    // Native frames read better with their JS caller chain.
    const native = frame !== undefined && frame.url === "";
    const key = native ? `${label(id)} <- ${label(parent.get(id))} <- ${label(parent.get(parent.get(id) ?? -1))}` : label(id);
    if (frame?.functionName === "(idle)") return;
    totals.set(key, (totals.get(key) ?? 0) + delta);
    all += delta;
  });
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)
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
  const text = textChunk(chunkBytes);
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
    // The v2 data frame: a JSON header, then the raw bytes.
    const envelope = serviceData("owner", "viewer", { streamId: "0b7c3a52-5f0e-4d43-9a8c-2f6d0f4a9e11", seq: 1, data });
    const binary = federationTransportCodecForTest.encodeEnvelope(envelope);
    const binaryCompressed = brotliCompressSync(binary, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } });
    cell("binaryFrameEncode", () => { federationTransportCodecForTest.encodeEnvelope(envelope); });
    cell("binaryFrameDecode", () => { federationTransportCodecForTest.decodeEnvelope(binary); });
    cell("binaryBrotliQ1Compress", () => { brotliCompressSync(binary, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 1 } }); });
    cell("binaryBrotliDecompress", () => { brotliDecompressSync(binaryCompressed); });
    // What the transport pays for one 64 KiB data frame with brotli on, probe included.
    const large = kind === "random" ? randomBytes(64 * 1024) : textChunk(64 * 1024);
    const frame = federationTransportCodecForTest.encodeEnvelope(serviceData("owner", "viewer", { streamId: "s", seq: 1, data: large }));
    // Four times the bytes per run, so a quarter of the runs.
    const before = process.cpuUsage();
    for (let i = 0; i < iterations / 4; i += 1) encodeFederationFramePayload({ json: frame, compressionEnabled: true });
    const used = process.cpuUsage(before);
    result[`${kind}.transportCompress64KiB`] = +(((used.user + used.system) / 1000) / (iterations * chunkBytes / MiB)).toFixed(3);
    result[`${kind}.binaryOverheadBytes`] = binary.length - data.length;
    result[`${kind}.binaryBrotliRatio`] = +(binaryCompressed.length / binary.length).toFixed(3);
  }
  return result;
}

describe.skipIf(!BENCH)("service tunnel throughput (measurement only)", () => {
  it("measures the codec cost per MiB", () => {
    report({ scenario: "codec cpu ms per MiB, 16 KiB chunks", ...codecMicrobench() });
  });

  const matrix: Array<{ path: Path; rttMs: number; payload?: Payload }> = [
    { path: "routed", rttMs: 0 }, { path: "routed", rttMs: 1 }, { path: "routed", rttMs: 20 },
    { path: "routed", rttMs: 50 }, { path: "routed", rttMs: 200 },
    { path: "gateway", rttMs: 0 }, { path: "gateway", rttMs: 20 }, { path: "gateway-plain", rttMs: 0 },
    { path: "gateway", rttMs: 0, payload: "text" }, { path: "gateway-plain", rttMs: 0, payload: "text" },
  ];
  for (const protocol of [1, 2] as const) {
    for (const { path, rttMs, payload = "random" } of matrix) {
      for (const direction of ["upload", "download", "duplex"] as const) {
        const scenario = `${path} v${protocol} rtt=${rttMs}ms ${direction}${payload === "text" ? " text" : ""}`;
        it.skipIf(FILTER !== "" && !scenario.includes(FILTER))(scenario, async () => {
          const seconds = rttMs >= 50 ? 4 : 2;
          const line = await measure({ path, protocol, rttMs, direction, seconds, payload });
          report({ scenario, path, protocol, rttMs, direction, payload, seconds, ...line });
          expect(line).toBeDefined();
        }, 60_000);
      }
    }
  }
});
