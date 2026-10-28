import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type Server, type Socket, type AddressInfo } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import type { FederationCapability, ServiceThread } from "@pwragent/shared";
import {
  FEDERATION_SERVICE_METHODS as METHODS, FEDERATION_SERVICE_V2_METHODS as V2,
  FEDERATION_SERVICE_V2_NOTIFICATIONS as FRAMES,
} from "@pwragent/shared";
import { FederationServices } from "../federation/federation-services";
import { FederationServiceForwarder } from "../federation/federation-service-forwarder";
import {
  ServiceStreamBudget, ServiceStreamEndpoint, ServiceStreamScheduler,
  SERVICE_STREAM_FRAME_BYTES, SERVICE_STREAM_MAX_WINDOW_BYTES,
} from "../federation/federation-service-stream";
import { ServiceLinkGate, serviceData, serviceLink, serviceNotification } from "./helpers/federation-service-link";

const thread: ServiceThread = { backend: "codex", threadId: "fixture-thread" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function listen(server: Server, host = "127.0.0.1"): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}
function owner(options: Partial<ConstructorParameters<typeof FederationServices>[0]> = {}): FederationServices {
  const service = new FederationServices({ instanceId: "owner", allowForwarding: () => true,
    threadExists: async (value) => value.threadId === thread.threadId, ...options });
  cleanups.push(() => service.dispose());
  return service;
}
function viewer(options: ConstructorParameters<typeof FederationServiceForwarder>[0] = {}): FederationServiceForwarder {
  const forwarder = new FederationServiceForwarder(options);
  cleanups.push(() => forwarder.dispose());
  return forwarder;
}
function client(port: number): { socket: Socket; received: () => Buffer; ended: Promise<unknown> } {
  const socket = connect({ host: "127.0.0.1", port, allowHalfOpen: true });
  cleanups.push(() => { socket.destroy(); });
  const chunks: Buffer[] = [];
  socket.on("data", (data: Buffer) => chunks.push(data));
  return { socket, received: () => Buffer.concat(chunks), ended: once(socket, "end") };
}
/** Run the event loop without the clock, long enough for any ready frame to go out. */
async function settle(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}
function methods(frames: ReturnType<typeof serviceLink>["frames"]): string[] {
  return frames.flatMap((frame) => frame.kind === "request" || frame.kind === "notification" ? [frame.method] : []);
}

for (const viaGateway of [false, true]) describe(viaGateway ? "windowed streams via gateway" : "windowed streams direct", () => {
  it("carries HTTP, WebSocket HMR and TCP half-close with no exchange per chunk", async () => {
    const http = createHttpServer((request, response) => {
      response.setHeader("Set-Cookie", "fixture=benign; SameSite=Lax");
      response.end(JSON.stringify({ host: request.headers.host, payload: "benign fixture" }));
    });
    const ws = new WebSocketServer({ server: http });
    ws.on("connection", (socket) => socket.on("message", (data) => socket.send(`hmr:${data}`)));
    const port = await listen(http);
    cleanups.push(() => { for (const entry of ws.clients) entry.terminate(); ws.close(); });
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "Fixture", protocol: "http" });
    const forwarder = viewer();
    const { rpc, frames } = serviceLink(service, forwarder, { viaGateway });
    const forward = await forwarder.connect(1, declaration, rpc, { streams: 2 });
    const response = await fetch(forward.url!);
    expect(response.headers.get("set-cookie")).toContain("fixture=benign");
    expect(await response.json()).toEqual({ host: `127.0.0.1:${forward.localPort}`, payload: "benign fixture" });
    const socket = new WebSocket(forward.url!.replace("http:", "ws:"));
    cleanups.push(() => socket.terminate());
    await once(socket, "open");
    const message = once(socket, "message");
    socket.send("refresh");
    expect(String((await message)[0])).toBe("hmr:refresh");
    expect(methods(frames)).toContain(V2.open);
    expect(methods(frames)).not.toContain(METHODS.exchange);
    expect(methods(frames)).not.toContain(METHODS.open);
    // Bytes travel raw in binary frames, never as base64 inside JSON.
    const data = frames.flatMap((frame) => frame.kind === "service_data" ? [frame] : []);
    expect(data.length).toBeGreaterThan(0);
    for (const frame of data) {
      expect(frame.data).toBeInstanceOf(Uint8Array);
      expect(frame.data.byteLength).toBeLessThanOrEqual(SERVICE_STREAM_FRAME_BYTES);
    }
    const closed = once(socket, "close");
    forwarder.disconnect(1, forward.forwardId);
    await closed;
    await expect(fetch(forward.url!)).rejects.toThrow();
  });

  it("preserves TCP half-close and returns the reply after request FIN", async () => {
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", () => undefined);
      socket.on("end", () => socket.end("reply after FIN"));
    });
    const port = await listen(server);
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "half close", protocol: "tcp" });
    const forwarder = viewer();
    const { rpc } = serviceLink(service, forwarder, { viaGateway });
    const forward = await forwarder.connect(1, declaration, rpc, { streams: 2 });
    const local = client(forward.localPort);
    local.socket.end("request");
    await local.ended;
    expect(local.received().toString()).toBe("reply after FIN");
  });
});

describe("windowed stream compatibility", () => {
  const cases: Array<{ name: string; ownerWindowed: boolean; capabilities?: FederationCapability[]; code: string }> = [
    { name: "an owner that predates windowed streams", ownerWindowed: false, code: "method_not_found" },
    { name: "a path without service_forward_v2", ownerWindowed: true, capabilities: ["service_forward_v1", "gateway_relay"], code: "capability_denied" },
  ];
  for (const entry of cases) it(`falls back to v1 exchanges for ${entry.name}`, async () => {
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end("v1 fixture"); });
    const port = await listen(server);
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "legacy", protocol: "tcp" });
    const forwarder = viewer();
    const { rpc, frames } = serviceLink(service, forwarder, { viaGateway: true, ownerWindowed: entry.ownerWindowed, capabilities: entry.capabilities });
    const forward = await forwarder.connect(1, declaration, rpc, { streams: 2 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const local = client(forward.localPort);
      local.socket.end();
      await local.ended;
      expect(local.received().toString()).toBe("v1 fixture");
    }
    // One refusal moves the forward to v1 for good.
    expect(methods(frames).filter((method) => method === V2.open)).toHaveLength(1);
    expect(methods(frames).filter((method) => method === METHODS.open)).toHaveLength(2);
    expect(methods(frames)).toContain(METHODS.exchange);
    const refusals = frames.filter((frame) => frame.kind === "error" && frame.error.code === entry.code);
    expect(refusals.length).toBeGreaterThanOrEqual(1);
  });
});

describe("windowed flow control", () => {
  const window = 256 * 1024;
  const frameBytes = 16 * 1024;
  // The receiver batches grants once a quarter-window drains. A fragmented
  // window can leave less than a quarter uncredited until more data arrives.
  const replenishedWindow = 3 * window / 4;

  it("waits for fragmented held data and starts a fresh byte count after flushing", async () => {
    const gate = new ServiceLinkGate();
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    gate.hold();
    let ready = false;
    const full = gate.waitForBytes(4, controller.signal).then(() => { ready = true; });
    const pass = (bytes: number) => gate.pass(serviceData("viewer", "owner", {
      streamId: "fixture", seq: 0, data: new Uint8Array(bytes),
    }), () => undefined);
    pass(2);
    gate.pass(serviceNotification("viewer", "owner", FRAMES.window, {}), () => undefined);
    await Promise.resolve();
    expect(ready).toBe(false);
    pass(2);
    await full;
    expect(gate.bytes).toBe(4);
    await gate.waitForBytes(4, controller.signal);
    gate.flush();
    const next = gate.waitForBytes(4, controller.signal);
    pass(5);
    await next;
    // Overshoot must reach the exact-window assertion rather than hang the wait.
    expect(gate.bytes).toBe(5);
  });

  it("cancels a pending held-byte wait when its test owner finishes", async () => {
    const gate = new ServiceLinkGate();
    const controller = new AbortController();
    gate.hold();
    const pending = gate.waitForBytes(4, controller.signal);
    const reason = new Error("fixture finished");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    await expect(gate.waitForBytes(4, controller.signal)).rejects.toBe(reason);
  });

  it("keeps one window of downloads in flight per round trip, whatever the round trip", async () => {
    const payload = randomBytes(4 * window + 12_345);
    const server = createServer({ allowHalfOpen: true }, (socket) => { socket.resume(); socket.end(payload); });
    const port = await listen(server);
    const service = owner({ streamWindow: window, streamFrameBytes: frameBytes });
    const declaration = await service.advertise(thread, { port, name: "download", protocol: "tcp" });
    const forwarder = viewer({ streamWindow: window, streamFrameBytes: frameBytes });
    const link = serviceLink(service, forwarder, { viaGateway: true });
    const forward = await forwarder.connect(1, declaration, link.rpc, { streams: 2 });
    link.down.hold();
    const local = client(forward.localPort);
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    // Each flush is one round trip. A v1 stream would carry one 16 KiB chunk per
    // round trip; a windowed one carries the available window, and never more.
    for (let round = 0; round < 4; round += 1) {
      const available = round === 0 ? window : replenishedWindow;
      await link.down.waitForBytes(available, controller.signal);
      await settle();
      expect(link.down.bytes).toBeGreaterThanOrEqual(available);
      expect(link.down.bytes).toBeLessThanOrEqual(window);
      link.down.flush();
    }
    link.down.open();
    local.socket.end();
    await local.ended;
    expect(local.received().equals(payload)).toBe(true);
  });

  it("keeps one window of uploads in flight per round trip", async () => {
    const payload = randomBytes(3 * window + 999);
    const uploaded: Buffer[] = [];
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.on("data", (data: Buffer) => uploaded.push(data));
      socket.on("end", () => { socket.end(); finished(); });
    });
    const port = await listen(server);
    const service = owner({ streamWindow: window, streamFrameBytes: frameBytes });
    const declaration = await service.advertise(thread, { port, name: "upload", protocol: "tcp" });
    const forwarder = viewer({ streamWindow: window, streamFrameBytes: frameBytes });
    const link = serviceLink(service, forwarder, { viaGateway: true });
    const forward = await forwarder.connect(1, declaration, link.rpc, { streams: 2 });
    link.up.hold();
    const local = client(forward.localPort);
    const controller = new AbortController();
    cleanups.push(() => controller.abort());
    // Force a non-frame-aligned read before sending the rest. Credit grants
    // then batch across fragmented frames rather than restoring an exact window.
    const prefixBytes = frameBytes + 19;
    local.socket.write(payload.subarray(0, prefixBytes));
    await link.up.waitForBytes(prefixBytes, controller.signal);
    local.socket.end(payload.subarray(prefixBytes));
    for (let round = 0; round < 3; round += 1) {
      const available = round === 0 ? window : replenishedWindow;
      await link.up.waitForBytes(available, controller.signal);
      await settle();
      expect(link.up.bytes).toBeGreaterThanOrEqual(available);
      expect(link.up.bytes).toBeLessThanOrEqual(window);
      link.up.flush();
    }
    link.up.open();
    await done;
    expect(Buffer.concat(uploaded).equals(payload)).toBe(true);
  });

  it("bounds receive memory across streams and serves a starved stream first", async () => {
    const payload = randomBytes(2 * window);
    const server = createServer({ allowHalfOpen: true }, (socket) => { socket.resume(); socket.end(payload); });
    const port = await listen(server);
    const service = owner({ streamFrameBytes: frameBytes });
    const declaration = await service.advertise(thread, { port, name: "budget", protocol: "tcp" });
    // One window of receive memory for two streams.
    const forwarder = viewer({ streamWindow: window, streamBudgetBytes: window, streamFrameBytes: frameBytes });
    const link = serviceLink(service, forwarder, { viaGateway: true });
    const forward = await forwarder.connect(1, declaration, link.rpc, { streams: 2 });
    link.down.hold();
    const first = client(forward.localPort);
    await once(first.socket, "connect");
    await vi.waitFor(() => expect(link.down.bytes).toBe(window));
    const second = client(forward.localPort);
    let done = 0;
    void first.ended.then(() => { done += 1; });
    void second.ended.then(() => { done += 1; });
    for (let round = 0; round < 40 && done < 2; round += 1) {
      await settle();
      expect(link.down.bytes).toBeLessThanOrEqual(window);
      link.down.flush();
      await vi.waitFor(() => expect(link.down.pending > 0 || done === 2).toBe(true));
    }
    link.down.open();
    await Promise.all([first.ended, second.ended]);
    expect(first.received().equals(payload)).toBe(true);
    expect(second.received().equals(payload)).toBe(true);
  });

  it("answers Federation control requests while a windowed transfer keeps streaming", async () => {
    const chunk = Buffer.alloc(64 * 1024, "g");
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    let sent = 0;
    const forwarder = viewer();
    const receivedBytes = (): number => forwarder.list(1, "owner", thread)[0]?.receivedBytes ?? 0;
    const server = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => {
        // Stream until the test releases it, staying ahead of the viewer.
        let open = true;
        void released.then(() => { open = false; });
        const pump = (): void => {
          if (!open || response.destroyed) { response.end(); return; }
          if (sent - receivedBytes() < 8 * chunk.length) {
            sent += chunk.length;
            response.write(chunk);
          }
          setImmediate(pump);
        };
        pump();
      });
    });
    const port = await listen(server);
    cleanups.push(() => release());
    const service = owner();
    const declaration = await service.advertise(thread, { port, name: "bulk", protocol: "http" });
    const { rpc, router } = serviceLink(service, forwarder, { viaGateway: true });
    router.registerHandler("fixture.control", () => ({ responsive: true }));
    const forward = await forwarder.connect(1, declaration, rpc, { streams: 2 });
    let finished = false;
    const transfer = fetch(forward.url!, { method: "POST", body: Buffer.alloc(1024 * 1024, "f") }).then(async (response) => {
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.length).toBe(sent);
      finished = true;
    });
    await vi.waitFor(() => expect(receivedBytes()).toBeGreaterThan(0), { timeout: 5000 });
    for (let i = 0; i < 4; i += 1) {
      const before = receivedBytes();
      expect(await rpc.request({ method: "fixture.control", params: {}, timeoutMs: 1000 })).toEqual({ responsive: true });
      await vi.waitFor(() => expect(receivedBytes()).toBeGreaterThan(before), { timeout: 5000 });
    }
    expect(finished).toBe(false);
    release();
    await transfer;
  });
});

describe("windowed stream lifecycle", () => {
  it("closes windowed streams with the reason when forwarding is disabled", async () => {
    let allowed = true;
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.write("hello"); });
    const port = await listen(server);
    const service = owner({ allowForwarding: () => allowed });
    const declaration = await service.advertise(thread, { port, name: "revoke", protocol: "tcp" });
    const forwarder = viewer();
    const { rpc } = serviceLink(service, forwarder, { viaGateway: true });
    const forward = await forwarder.connect(1, declaration, rpc, { streams: 2 });
    const local = client(forward.localPort);
    await vi.waitFor(() => expect(local.received().toString()).toBe("hello"));
    allowed = false; // The owner's reaper notices without another request.
    await local.ended;
    expect(forwarder.list(1, "owner", thread)[0]?.error).toContain("revoked");
  });

  it("leaves the lease unrenewed when a renewal names an invalid stream", async () => {
    let now = 1000;
    const server = createServer((socket) => { socket.on("error", () => undefined); });
    const port = await listen(server);
    const service = owner({ now: () => now });
    const declaration = await service.advertise(thread, { port, name: "renewal", protocol: "tcp" });
    const { leaseId } = await service.lease("viewer", thread, declaration.serviceId);
    now += 20_000;
    expect(() => service.renewStreams("viewer", { leaseId, streamIds: ["stream-ok", 7 as never] })).toThrow("Invalid service identifier");
    expect(() => service.renewStreams("viewer", { leaseId, streamIds: "stream-ok" as never })).toThrow("Invalid service stream list");
    now += 11_000;
    // Neither refused renewal extended the lease.
    expect(() => service.renew("viewer", leaseId)).toThrow("expired or was revoked");
  });

  it("reaps windowed streams that renewals stop naming", async () => {
    let now = 1000;
    const server = createServer((socket) => { socket.on("error", () => undefined); });
    const port = await listen(server);
    const service = owner({ now: () => now });
    const sent: Array<{ method: string; params: unknown }> = [];
    service.setStreamLink({ notify: (_peerId, method, params) => { sent.push({ method, params }); }, sendData: () => undefined });
    const declaration = await service.advertise(thread, { port, name: "idle", protocol: "tcp" });
    const { leaseId } = await service.lease("viewer", thread, declaration.serviceId);
    for (const streamId of ["stream-named", "stream-forgotten"]) {
      await service.openStream("viewer", { leaseId, streamId, window: 65_536, frameBytes: 16_384 });
    }
    now += 20_000;
    service.renewStreams("viewer", { leaseId, streamIds: ["stream-named"] });
    now += 11_000;
    await service.list(thread);
    const closes = sent.filter((entry) => entry.method === FRAMES.close).map((entry) => entry.params);
    expect(closes).toEqual([{ streamId: "stream-forgotten", error: "Service stream was idle." }]);
    expect(service.receiveNotification("viewer", FRAMES.window, { streamId: "stream-named", bytes: 1 })).toBe(true);
    expect(service.receiveNotification("viewer", FRAMES.window, { streamId: "stream-forgotten", bytes: 1 })).toBe(false);
    // Another peer cannot address the stream.
    expect(service.receiveNotification("intruder", FRAMES.window, { streamId: "stream-named", bytes: 1 })).toBe(false);
  });

  it("refuses stream ids in use, invalid windows, and opens without a lease", async () => {
    const server = createServer((socket) => { socket.on("error", () => undefined); });
    const port = await listen(server);
    const service = owner();
    service.setStreamLink({ notify: () => undefined, sendData: () => undefined });
    const declaration = await service.advertise(thread, { port, name: "limits", protocol: "tcp" });
    const { leaseId } = await service.lease("viewer", thread, declaration.serviceId);
    await service.openStream("viewer", { leaseId, streamId: "taken", window: 65_536, frameBytes: 16_384 });
    await expect(service.openStream("viewer", { leaseId, streamId: "taken", window: 65_536, frameBytes: 16_384 })).rejects.toThrow("already exists");
    await expect(service.openStream("viewer", { leaseId, streamId: "huge", window: SERVICE_STREAM_MAX_WINDOW_BYTES + 1, frameBytes: 16_384 })).rejects.toThrow("parameters");
    await expect(service.openStream("intruder", { leaseId, streamId: "stolen", window: 65_536, frameBytes: 16_384 })).rejects.toThrow("revoked");
    await expect(service.exchange("viewer", { streamId: "taken", seq: 0, data: "", fin: false, receive: true })).rejects.toThrow("windowed");
  });
});

describe("windowed stream endpoint", () => {
  async function endpoint(window: number) {
    const accepted = new Set<Socket>();
    const server = createServer((socket) => { accepted.add(socket); socket.on("error", () => undefined); socket.resume(); });
    const port = await listen(server);
    cleanups.push(() => { for (const socket of accepted) socket.destroy(); });
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    const budget = new ServiceStreamBudget();
    const stream = new ServiceStreamEndpoint({ streamId: "s", socket, scheduler: new ServiceStreamScheduler(), budget, window,
      send: (method, params) => { sent.push({ method, params: params as Record<string, unknown> }); }, sendData: () => undefined });
    stream.start(window, 16_384);
    return { stream, socket, sent, budget };
  }
  const bytes = (length: number): Uint8Array => Buffer.alloc(length, 1);
  const violations: Array<[string, (stream: ServiceStreamEndpoint) => void, string]> = [
    ["data beyond the granted window", (stream) => stream.receiveData({ seq: 0, data: bytes(8192) }), "window"],
    ["a frame out of sequence", (stream) => stream.receiveData({ seq: 1, data: bytes(16) }), "sequence"],
    ["a frame without binary data", (stream) => stream.receiveData({ seq: 0, data: "AAAA" as never }), "Invalid service stream frame"],
    ["a frame larger than the frame size", (stream) => stream.receiveData({ seq: 0, data: bytes(SERVICE_STREAM_FRAME_BYTES + 1) }), "Invalid service stream frame"],
    ["data after FIN", (stream) => { stream.receiveData({ seq: 0, data: bytes(0), fin: true }); stream.receiveData({ seq: 1, data: bytes(3) }); }, "after FIN"],
    ["credit past the ceiling", (stream) => stream.receiveWindow({ bytes: SERVICE_STREAM_MAX_WINDOW_BYTES }), "window"],
  ];
  for (const [name, violate, error] of violations) it(`closes the stream on ${name}`, async () => {
    const { stream, socket, sent, budget } = await endpoint(4096);
    const closed = once(socket, "close");
    violate(stream);
    await closed;
    expect(stream.isClosed).toBe(true);
    expect(sent.find((entry) => entry.method === FRAMES.close)?.params.error).toContain(error);
    // Closing returns the stream's whole grant.
    expect(budget.inUse).toBe(0);
  });

  it("flushes pending local writes when the peer closes after its FIN", async () => {
    const window = 16 * 1024 * 1024;
    const accepted = new Set<Socket>();
    const server = createServer((socket) => { accepted.add(socket); socket.pause(); });
    const port = await listen(server);
    cleanups.push(() => { for (const socket of accepted) socket.destroy(); });
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    await once(socket, "connect");
    const stream = new ServiceStreamEndpoint({ streamId: "s", socket, scheduler: new ServiceStreamScheduler(),
      budget: new ServiceStreamBudget(window), window, send: () => undefined, sendData: () => undefined });
    stream.start(window, 16_384);
    await vi.waitFor(() => expect(accepted.size).toBe(1));
    const [reader] = [...accepted];
    const frame = Buffer.alloc(SERVICE_STREAM_FRAME_BYTES, 7);
    const frames = window / SERVICE_STREAM_FRAME_BYTES;
    for (let seq = 0; seq < frames; seq += 1) stream.receiveData({ seq, data: frame });
    stream.receiveData({ seq: frames, data: new Uint8Array(0), fin: true });
    // The reader is paused, so most of the window is still queued locally.
    expect(socket.writableLength).toBeGreaterThan(0);
    stream.receiveClose({ streamId: "s" });
    let received = 0;
    reader!.on("data", (data: Buffer) => { received += data.length; });
    const ended = once(reader!, "end");
    reader!.resume();
    await ended;
    expect(received).toBe(window);
    await vi.waitFor(() => expect(stream.isClosed).toBe(true));
  });

  it("holds the close behind a FIN frame that is waiting for transport capacity", async () => {
    const server = createServer((socket) => { socket.on("error", () => undefined); socket.end("last bytes"); });
    const port = await listen(server);
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("error", () => undefined);
    const order: string[] = [];
    let releaseFin!: () => void;
    const stream = new ServiceStreamEndpoint({ streamId: "s", socket, scheduler: new ServiceStreamScheduler(),
      budget: new ServiceStreamBudget(), window: 65_536,
      send: (method) => { order.push(method); },
      sendData: (frame) => {
        order.push(frame.fin ? "fin-queued" : "data");
        // The transport is congested for the FIN frame.
        if (frame.fin) return new Promise<void>((resolve) => { releaseFin = () => { order.push("fin-sent"); resolve(); }; });
      } });
    stream.start(65_536, 16_384);
    // The service ended, so the socket closes while the FIN still waits.
    await once(socket, "close");
    await vi.waitFor(() => expect(order).toContain("fin-queued"));
    expect(order).not.toContain(FRAMES.close);
    releaseFin();
    await vi.waitFor(() => expect(stream.isClosed).toBe(true));
    expect(order.slice(order.indexOf("fin-queued"))).toEqual(["fin-queued", "fin-sent", FRAMES.close]);
  });

  it("grants credit back as the local socket drains, in batches", async () => {
    const { stream, sent, socket } = await endpoint(4096);
    cleanups.push(() => { socket.destroy(); });
    stream.receiveData({ seq: 0, data: bytes(1024) });
    await vi.waitFor(() => expect(sent.filter((entry) => entry.method === FRAMES.window)).toEqual([
      { method: FRAMES.window, params: { streamId: "s", bytes: 1024 } },
    ]));
    expect(stream.peerCredit).toBe(4096);
    stream.receiveData({ seq: 1, data: bytes(512) });
    await settle();
    // Below a quarter of the window: no grant yet.
    expect(sent.filter((entry) => entry.method === FRAMES.window)).toHaveLength(1);
  });
});
