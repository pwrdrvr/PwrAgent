import { afterEach, describe, expect, it } from "vitest";
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
function owner(options: { now?: () => number; threadExists?: (value: ServiceThread) => Promise<boolean>; blockedPorts?: () => number[] } = {}) {
  const service = new FederationServices({ instanceId: "owner", threadExists: async (value) => value.threadId === thread.threadId, ...options });
  cleanups.push(() => service.dispose());
  return service;
}
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
    await expect(service.exchange("intruder", { ...streams[0]!, seq: 0, data: "", fin: false })).rejects.toThrow("revoked");
    await expect(service.exchange("viewer", { ...streams[0]!, seq: 99, data: "", fin: false })).rejects.toThrow("sequence");
    service.disconnect("viewer");
    await expect(service.open("viewer", lease.leaseId)).rejects.toThrow("revoked");
    const nextLease = await service.lease("viewer", thread, declaration.serviceId);
    await service.open("viewer", nextLease.leaseId);
    service.remove(thread, declaration.serviceId);
    await expect(service.open("viewer", nextLease.leaseId)).rejects.toThrow("revoked");
  });
});
