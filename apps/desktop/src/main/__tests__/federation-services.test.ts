import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import { serviceTlsFixture } from "./helpers/service-tls-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server, type AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import type { FederationCapability, FederationProtocolEnvelope, ServiceThread } from "@pwragent/shared";
import { FEDERATION_SERVICE_METHODS as METHODS } from "@pwragent/shared";
import { FederationServices, parseServiceAdvertisement, registerFederationServices, SERVICE_METHOD_CAPABILITIES } from "../federation/federation-services";
import { FederationServiceForwarder } from "../federation/federation-service-forwarder";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { decodeServiceData, SERVICE_CHUNK_BYTES } from "../federation/federation-service-socket";

const thread: ServiceThread = { backend: "codex", threadId: "fixture-thread" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}
function owner(options: { allowForwarding?: () => boolean; now?: () => number; threadExists?: (value: ServiceThread) => Promise<boolean>; blockedPorts?: () => number[] } = {}) {
  const service = new FederationServices({ instanceId: "owner", allowForwarding: () => true, threadExists: async (value) => value.threadId === thread.threadId, ...options });
  cleanups.push(() => service.dispose());
  return service;
}

it("allows declarations while disabled but denies forwarding even with the protocol capability", async () => {
  const service = owner({ allowForwarding: () => false });
  const declaration = await service.advertise(thread, { port: 3000, name: "Preview", protocol: "http" });
  const { rpc } = routed(service, true);
  await expect(rpc.request({ method: METHODS.list, params: thread })).resolves.toEqual([declaration]);
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  await expect(forwarder.connect(1, declaration, rpc)).rejects.toThrow("Allow port forwarding");
  expect(forwarder.list(1, "owner", thread)).toEqual([]);
});

it("checks permission again after an in-flight thread lookup", async () => {
  let allowed = true;
  const service = owner({ allowForwarding: () => allowed });
  const declaration = await service.advertise(thread, { port: 3000, name: "Preview", protocol: "http" });
  const pending = service.lease("viewer", thread, declaration.serviceId);
  allowed = false;
  await expect(pending).rejects.toThrow("Allow port forwarding");
});

it("revokes idle sockets and leases when permission changes without restoring them on enable", async () => {
  let allowed = true;
  const server = createServer();
  const port = await listen(server);
  const service = owner({ allowForwarding: () => allowed });
  const declaration = await service.advertise(thread, { port, name: "Preview", protocol: "tcp" });
  const { leaseId } = await service.lease("viewer", thread, declaration.serviceId);
  const accepted = once(server, "connection");
  const { streamId } = await service.open("viewer", leaseId);
  const [socket] = await accepted;
  socket.resume();
  const closed = once(socket, "close");
  // The owner reaper notices revocation even without a further client request.
  allowed = false;
  await closed;
  expect(() => service.renew("viewer", leaseId)).toThrow("Allow port forwarding");
  await expect(service.open("viewer", leaseId)).rejects.toThrow("Allow port forwarding");
  await expect(service.exchange("viewer", { streamId, seq: 0, data: "", fin: false, receive: true })).rejects.toThrow();
  allowed = true;
  expect(() => service.renew("viewer", leaseId)).toThrow("revoked");
  await expect(service.list(thread)).resolves.toEqual([declaration]);
  await expect(service.lease("viewer", thread, declaration.serviceId)).resolves.toHaveProperty("leaseId");
});

it("skips thread discovery for empty inventories even when other threads declare services", async () => {
  const threadExists = vi.fn(async () => true);
  const service = owner({ threadExists });
  for (let poll = 0; poll < 3; poll++) await expect(service.list(thread)).resolves.toEqual([]);
  expect(threadExists).not.toHaveBeenCalled();
  const declaration = await service.advertise(thread, { port: 3000, name: "Preview", protocol: "http" });
  threadExists.mockClear();
  await expect(service.list({ ...thread, threadId: "other-thread" })).resolves.toEqual([]);
  await expect(service.list({ ...thread, backend: "acp:fixture" })).resolves.toEqual([]);
  expect(threadExists).not.toHaveBeenCalled();
  await expect(service.list(thread)).resolves.toEqual([declaration]);
  expect(threadExists).toHaveBeenCalledExactlyOnceWith(thread);
  service.remove(thread, declaration.serviceId);
  threadExists.mockClear();
  await expect(service.list(thread)).resolves.toEqual([]);
  expect(threadExists).not.toHaveBeenCalled();
});

it("prunes expired declarations before deciding whether discovery is needed", async () => {
  let now = 0;
  const threadExists = vi.fn(async () => true);
  const service = owner({ threadExists, now: () => now });
  await service.advertise(thread, { port: 3000, name: "Preview", protocol: "http", ttlSeconds: 60 });
  const other = { ...thread, threadId: "other-thread" };
  await service.advertise(other, { port: 3001, name: "Other preview", protocol: "http" });
  threadExists.mockClear();
  now = 60_000;
  await expect(service.list(thread)).resolves.toEqual([]);
  expect(threadExists).not.toHaveBeenCalled();
  await expect(service.list(other)).resolves.toHaveLength(1);
  expect(threadExists).toHaveBeenCalledExactlyOnceWith(other);
});

it("retains advertisements and leases on failed lookups but revokes confirmed absent threads", async () => {
  vi.useFakeTimers();
  const threadExists = vi.fn(async () => true);
  const service = owner({ threadExists });
  try {
    const declaration = await service.advertise(thread, { port: 3000, name: "Preview", protocol: "http" });
    const { leaseId } = await service.lease("viewer", thread, declaration.serviceId);
    threadExists.mockRejectedValue(new Error("Provider unavailable"));
    await expect(service.list(thread)).rejects.toThrow("Provider unavailable");
    await vi.advanceTimersByTimeAsync(1000); // Background reaping must retain it too.
    expect(() => service.renew("viewer", leaseId)).not.toThrow();
    threadExists.mockResolvedValue(true);
    await expect(service.list(thread)).resolves.toEqual([declaration]);
    threadExists.mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(() => service.renew("viewer", leaseId)).toThrow();
    threadExists.mockResolvedValue(true);
    await expect(service.list(thread)).resolves.toEqual([]);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});
function routed(service: FederationServices, viaGateway: boolean) {
  const capabilities: FederationCapability[] = ["service_forward_v1", "gateway_relay"];
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: SERVICE_METHOD_CAPABILITIES,
    trustedRelayPeerId: viaGateway ? "gateway" : undefined });
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const frames: FederationProtocolEnvelope[] = [];
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner",
    sendEnvelope: (envelope) => {
      frames.push(envelope);
      void (viaGateway ? gateway : router).routeEnvelope({ envelope, sourcePeerId: "viewer" });
    }, defaultTimeoutMs: 2000 });
  router.registerConnection({ peerId: viaGateway ? "gateway" : "viewer", capabilities,
    sendEnvelope: (envelope) => {
      frames.push(envelope);
      if (viaGateway) void gateway.routeEnvelope({ envelope, sourcePeerId: "owner" });
      else rpc.receiveEnvelope(envelope);
    } });
  gateway.registerConnection({ peerId: "owner", capabilities, sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "gateway" }); } });
  gateway.registerConnection({ peerId: "viewer", capabilities, sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  registerFederationServices(router, service);
  cleanups.push(() => rpc.rejectAll(new Error("Test complete")));
  return { rpc, router, gateway, frames };
}

for (const viaGateway of [false, true]) describe(viaGateway ? "gateway service forwarding" : "direct service forwarding", () => {
  it("forwards real HTTP, Host/Origin/cookies and WebSocket HMR; cleans the listener on disconnect", async () => {
    const http = createHttpServer((request, response) => {
      response.setHeader("Set-Cookie", "fixture=benign; SameSite=Lax");
      response.end(JSON.stringify({ host: request.headers.host, origin: request.headers.origin, payload: "benign fixture" }));
    });
    const ws = new WebSocketServer({ server: http });
    ws.on("connection", (socket) => socket.on("message", (data) => socket.send(`hmr:${data}`)));
    const port = await listen(http);
    cleanups.push(() => { for (const client of ws.clients) client.terminate(); ws.close(); });
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "Fixture", protocol: "http" });
    const { rpc, frames } = routed(service, viaGateway);
    const forwarder = new FederationServiceForwarder();
    cleanups.push(() => forwarder.dispose());
    const forward = await forwarder.connect(1, declaration, rpc);
    expect(forward.localPort).not.toBe(port);
    const response = await fetch(forward.url!, { headers: { Origin: forward.url!.slice(0, -1) } });
    expect(response.headers.get("set-cookie")).toContain("fixture=benign");
    expect(await response.json()).toEqual({ host: `127.0.0.1:${forward.localPort}`, origin: forward.url!.slice(0, -1), payload: "benign fixture" });
    const client = new WebSocket(forward.url!.replace("http:", "ws:"));
    cleanups.push(() => client.terminate());
    await once(client, "open");
    const message = once(client, "message");
    client.send("refresh");
    expect(String((await message)[0])).toBe("hmr:refresh");
    expect(forwarder.list(1, "owner", thread)[0]?.receivedBytes).toBeGreaterThan(0);
    expect(forwarder.list(2, "owner", thread)).toEqual([]);
    for (const frame of frames) {
      if (frame.kind === "request" && frame.method === METHODS.exchange) {
        expect(Buffer.from((frame.params as { data: string }).data, "base64").length).toBeLessThanOrEqual(SERVICE_CHUNK_BYTES);
      }
    }
    const closed = once(client, "close");
    forwarder.disconnect(1, forward.forwardId);
    await closed;
    expect(forwarder.list(1, "owner", thread)).toEqual([]);
    await expect(fetch(forward.url!)).rejects.toThrow();
  });
});

describe("service boundaries and lifecycle", () => {
  it("validates literal targets and never accepts owner, thread or URL in declarations", () => {
    for (const address of ["localhost", "127.1", "0.0.0.0", "::", "::ffff:127.0.0.1", "192.168.1.1", "https://127.0.0.1", "example.com"]) {
      expect(() => parseServiceAdvertisement({ port: 3000, name: "fixture", protocol: "http", address })).toThrow();
    }
    for (const port of [0, 22, 1023, 65536, 3000.5]) expect(() => parseServiceAdvertisement({ port, name: "fixture", protocol: "tcp" })).toThrow();
    expect(() => parseServiceAdvertisement({ port: 3000, name: "fixture", protocol: "tcp", threadId: "other" })).toThrow();
    expect(() => decodeServiceData("!notbase64")).toThrow();
    expect(() => decodeServiceData(Buffer.alloc(SERVICE_CHUNK_BYTES + 1).toString("base64"))).toThrow();
  });

  it("scopes inventory and revocation to the authenticated thread and peer; expires declarations", async () => {
    let now = 1000;
    const service = owner({ now: () => now, blockedPorts: () => [47830] });
    await expect(service.advertise(thread, { port: 47830, name: "Control", protocol: "tcp" })).rejects.toThrow("control ports");
    const declaration = await service.advertise(thread, { port: 3000, name: "Fixture", protocol: "http", ttlSeconds: 60 });
    expect(await service.list({ ...thread, threadId: "other" })).toEqual([]);
    expect(() => service.remove({ ...thread, threadId: "other" }, declaration.serviceId)).toThrow("this thread");
    const lease = await service.lease("viewer", thread, declaration.serviceId);
    expect(() => service.renew("intruder", lease.leaseId)).toThrow("revoked");
    expect(() => service.release("intruder", lease.leaseId)).toThrow("another viewer");
    now += 31_000;
    expect(() => service.renew("viewer", lease.leaseId)).toThrow("expired");
    now += 30_000;
    expect(await service.list(thread)).toEqual([]);
    await expect(service.lease("viewer", thread, declaration.serviceId)).rejects.toThrow("no longer");
  });

  it("reports each peer holding a live lease once, for the owner's in-use indicator", async () => {
    let now = 1000;
    const service = owner({ now: () => now });
    const declaration = await service.advertise(thread, { port: 3000, name: "Fixture", protocol: "http" });
    expect(service.leaseHolders(declaration.serviceId)).toEqual([]);
    const first = await service.lease("laptop", thread, declaration.serviceId);
    await service.lease("laptop", thread, declaration.serviceId);
    await service.lease("desk", thread, declaration.serviceId);
    expect(service.leaseHolders(declaration.serviceId)).toEqual(["laptop", "desk"]);
    service.release("laptop", first.leaseId);
    expect(service.leaseHolders(declaration.serviceId)).toEqual(["laptop", "desk"]);
    now += 31_000;
    expect(service.leaseHolders(declaration.serviceId)).toEqual([]);
  });

  it("preserves TCP half-close and returns the reply after request FIN", async () => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", () => undefined);
      socket.on("end", () => socket.end("reply after FIN"));
    });
    const port = await listen(server);
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "half close", protocol: "tcp" });
    const { rpc } = routed(service, true);
    const forwarder = new FederationServiceForwarder();
    cleanups.push(() => forwarder.dispose());
    const forward = await forwarder.connect(1, declaration, rpc);
    expect(forward.url).toBeUndefined();
    const socket = connect({ host: "127.0.0.1", port: forward.localPort, allowHalfOpen: true });
    cleanups.push(() => { socket.destroy(); });
    let response = "";
    socket.on("data", (chunk) => { response += String(chunk); });
    const ended = once(socket, "end");
    socket.end("request");
    await ended;
    expect(response).toBe("reply after FIN");
  });

  it("rejects spoofed origins and missing capabilities before dispatch", async () => {
    const service = owner();
    const { router } = routed(service, false);
    const request = { id: "spoof", kind: "request" as const, method: METHODS.list, params: thread,
      protocolVersion: 1 as const, sourceInstanceId: "victim", targetInstanceId: "owner", createdAt: Date.now() };
    expect(await router.routeEnvelope({ envelope: request, sourcePeerId: "viewer" })).toMatchObject({ status: "rejected", code: "relay_origin_mismatch" });
    router.registerConnection({ peerId: "viewer", capabilities: [], sendEnvelope: () => undefined });
    expect(await router.routeEnvelope({ envelope: { ...request, sourceInstanceId: "viewer" }, sourcePeerId: "viewer" })).toMatchObject({ status: "rejected", code: "capability_denied" });
  });

  it("enforces limits, removes active sockets, and requires a new lease after peer disconnect", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
    const port = await listen(server);
    cleanups.push(() => { for (const socket of sockets) socket.destroy(); });
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "fixture", protocol: "tcp" });
    const lease = await service.lease("viewer", thread, declaration.serviceId);
    const streams = await Promise.all(Array.from({ length: 8 }, () => service.open("viewer", lease.leaseId)));
    await expect(service.open("viewer", lease.leaseId)).rejects.toThrow("limit");
    await expect(service.exchange("intruder", { ...streams[0]!, seq: 0, data: "", fin: false, receive: true })).rejects.toThrow("revoked");
    await expect(service.exchange("viewer", { ...streams[0]!, seq: 99, data: "", fin: false, receive: true })).rejects.toThrow("sequence");
    service.disconnect("viewer");
    await expect(service.open("viewer", lease.leaseId)).rejects.toThrow("revoked");
    const nextLease = await service.lease("viewer", thread, declaration.serviceId);
    await service.open("viewer", nextLease.leaseId);
    service.remove(thread, declaration.serviceId);
    await expect(service.open("viewer", nextLease.leaseId)).rejects.toThrow("revoked");
  });
});

it("cancels a pending activation and releases a late lease without opening a listener", async () => {
  const service = owner();
  const declaration = await service.advertise(thread, { port: 3000, name: "Fixture", protocol: "http" });
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const { rpc } = routed(service, false);
  let resolveLease!: (value: { leaseId: string }) => void;
  const lateLease = new Promise<{ leaseId: string }>((resolve) => { resolveLease = resolve; });
  const wrapped = { request: <T>(params: Parameters<typeof rpc.request>[0]): Promise<T> => params.method === METHODS.lease
    ? lateLease as Promise<T> : rpc.request<T>(params) };
  const pending = forwarder.connect(1, declaration, wrapped);
  const outcome = expect(pending).rejects.toThrow("cancelled");
  forwarder.leave(1);
  const lease = await service.lease("viewer", thread, declaration.serviceId);
  resolveLease(lease);
  await outcome;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(forwarder.list(1, "owner", thread)).toEqual([]);
  expect(() => service.renew("viewer", lease.leaseId)).toThrow("revoked");
});

it("supports declared IPv6 loopback without DNS and refuses stopped services", async () => {
  const server = createServer((socket) => { socket.on("error", () => undefined); socket.end("ipv6 fixture"); });
  const port = await listen(server, "::1");
  const service = owner();
  const declaration = await service.advertise(thread, { port, address: "::1", name: "IPv6", protocol: "tcp" });
  const lease = await service.lease("viewer", thread, declaration.serviceId);
  const stream = await service.open("viewer", lease.leaseId);
  const response = await service.exchange("viewer", { ...stream, seq: 0, data: "", fin: true, receive: true });
  expect(Buffer.from(response.data, "base64").toString()).toBe("ipv6 fixture");
  service.close("viewer", stream.streamId);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await expect(service.open("viewer", lease.leaseId)).rejects.toThrow("not accepting");
});

it("streams a multi-quantum upload/download while unrelated Federation control requests run", async () => {
  const payload = Buffer.alloc(512 * 1024, "f");
  const server = createHttpServer((request, response) => {
    let received = 0;
    request.on("data", (data: Buffer) => { received += data.length; });
    request.on("end", () => { response.setHeader("X-Fixture-Received", received); response.end(payload); });
  });
  const port = await listen(server);
  const service = owner();
  const declaration = await service.advertise(thread, { port, name: "bulk", protocol: "http" });
  const { rpc, router } = routed(service, true);
  router.registerHandler("fixture.control", () => ({ responsive: true }));
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const forward = await forwarder.connect(1, declaration, rpc);
  let finished = false;
  const transfer = fetch(forward.url!, { method: "POST", body: payload }).then(async (response) => {
    expect(response.headers.get("x-fixture-received")).toBe(String(payload.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    finished = true;
  });
  for (let i = 0; i < 4; i += 1) {
    expect(await rpc.request({ method: "fixture.control", params: {}, timeoutMs: 1000 })).toEqual({ responsive: true });
  }
  expect(finished).toBe(false);
  await transfer;
  const stats = forwarder.list(1, "owner", thread)[0]!;
  expect(stats.sentBytes).toBeGreaterThanOrEqual(payload.length);
  expect(stats.receivedBytes).toBeGreaterThanOrEqual(payload.length);
});


it("passes HTTPS through to the app and retains normal certificate validation", async () => {
  const tls = await serviceTlsFixture();
  const server = createHttpsServer(tls, (_request, response) => response.end("TLS fixture"));
  const port = await listen(server);
  const service = owner();
  const declaration = await service.advertise(thread, { port, name: "TLS", protocol: "https" });
  const { rpc } = routed(service, true);
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const forward = await forwarder.connect(1, declaration, rpc);
  const read = (ca?: string): Promise<string> => new Promise((resolve, reject) => {
    const request = httpsGet(forward.url!, { ca, agent: false }, (response) => {
      let text = "";
      response.on("data", (data) => { text += String(data); });
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
  });
  await expect(read()).rejects.toThrow();
  expect(await read(tls.cert)).toBe("TLS fixture");
});
