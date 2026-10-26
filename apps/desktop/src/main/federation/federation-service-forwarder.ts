import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type {
  ServiceForward, ServiceThread, ThreadService, ServiceExchangeResult, ServiceStreamData, ServiceStreamOpen,
  ServiceStreamOpened,
} from "@pwragent/shared";
import {
  FEDERATION_SERVICE_METHODS as METHODS, FEDERATION_SERVICE_V2_METHODS as V2,
  FEDERATION_SERVICE_V2_NOTIFICATIONS as FRAMES,
} from "@pwragent/shared";
import {
  decodeServiceData, readServiceData, waitServiceReadable, writeServiceData, SERVICE_MAX_PEER_STREAMS,
} from "./federation-service-socket";
import {
  ServiceStreamBudget, ServiceStreamEndpoint, ServiceStreamScheduler, SERVICE_STREAM_FRAME_BYTES,
} from "./federation-service-stream";

export type ServiceRpc = {
  request<T>(params: { method: string; params: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
  /** One-way frames for windowed streams. Without both the forward uses v1 exchanges. */
  notify?(method: string, params: unknown): void | Promise<void>;
  sendServiceData?(frame: ServiceStreamData): void | Promise<void>;
};
type Forward = {
  windowId: number; view: ServiceForward; rpc: ServiceRpc; server: Server;
  abort: AbortController; sockets: Set<Socket>; leaseId?: string;
  renewal?: ReturnType<typeof setInterval>; renewing: boolean;
  /** 2 while the owner accepts windowed streams; drops to 1 for good on refusal. */
  version: 1 | 2;
  streams: Set<string>;
};
type WindowedStream = { forward: Forward; endpoint: ServiceStreamEndpoint };

function unsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "method_not_found" || code === "capability_denied";
}

/** Viewer-owned listeners; never binds any interface except literal IPv4 loopback. */
export class FederationServiceForwarder {
  private readonly forwards = new Map<string, Forward>();
  private readonly streams = new Map<string, WindowedStream>();
  /** One per owner, so one owner's transport backpressure never stalls another's streams. */
  private readonly schedulers = new Map<string, ServiceStreamScheduler>();
  private readonly budget: ServiceStreamBudget;

  constructor(private readonly options: {
    /** Windowed streams: per-stream receive window, total receive memory, frame size. */
    streamWindow?: number;
    streamBudgetBytes?: number;
    streamFrameBytes?: number;
  } = {}) {
    this.budget = new ServiceStreamBudget(options.streamBudgetBytes);
  }

  /** Route a windowed-stream frame from owner `peerId`. False when no stream claims it. */
  receiveNotification(peerId: string, method: string, params: unknown): boolean {
    const endpoint = this.receivingEndpoint(peerId, params);
    if (!endpoint) return false;
    const frame = params as Record<string, never>;
    if (method === FRAMES.window) endpoint.receiveWindow(frame);
    else if (method === FRAMES.close) endpoint.receiveClose(frame);
    return true;
  }

  receiveData(peerId: string, frame: ServiceStreamData): boolean {
    const endpoint = this.receivingEndpoint(peerId, frame);
    endpoint?.receiveData(frame);
    return endpoint !== undefined;
  }

  private receivingEndpoint(peerId: string, frame: unknown): ServiceStreamEndpoint | undefined {
    const streamId = (frame as { streamId?: unknown } | undefined)?.streamId;
    const stream = typeof streamId === "string" ? this.streams.get(streamId) : undefined;
    return stream?.forward.view.service.ownerInstanceId === peerId ? stream.endpoint : undefined;
  }

  list(windowId: number, instanceId: string, thread: ServiceThread): ServiceForward[] {
    return [...this.forwards.values()].filter((entry) => entry.windowId === windowId
      && entry.view.service.ownerInstanceId === instanceId
      && entry.view.service.backend === thread.backend && entry.view.service.threadId === thread.threadId)
      .map((entry) => ({ ...entry.view, service: { ...entry.view.service } }));
  }

  /** `streams: 2` asks the owner for windowed streams and falls back to v1 when refused. */
  async connect(windowId: number, service: ThreadService, rpc: ServiceRpc, options: { streams?: 1 | 2 } = {}): Promise<ServiceForward> {
    const existing = this.list(windowId, service.ownerInstanceId, service).find((entry) => entry.service.serviceId === service.serviceId);
    if (existing?.localPort === 0) throw new Error("Service connection is already pending.");
    if (existing) return existing;
    if (this.forwards.size >= 16) throw new Error("Local forwarding limit reached.");
    const version = options.streams === 2 && rpc.notify && rpc.sendServiceData ? 2 : 1;
    const frameBytes = this.options.streamFrameBytes ?? SERVICE_STREAM_FRAME_BYTES;
    const server = createServer({ allowHalfOpen: true, highWaterMark: version === 2 ? 2 * frameBytes : 32 * 1024, pauseOnConnect: true });
    const forward: Forward = {
      windowId, view: { forwardId: randomUUID(), service, localPort: 0, sentBytes: 0, receivedBytes: 0 },
      rpc, server, abort: new AbortController(), sockets: new Set(), renewing: false, version, streams: new Set(),
    };
    this.forwards.set(forward.view.forwardId, forward);
    server.maxConnections = SERVICE_MAX_PEER_STREAMS;
    server.on("connection", (socket) => {
      socket.on("error", () => { /* pump owns the surfaced error and cleanup */ });
      if (forward.abort.signal.aborted || forward.sockets.size >= SERVICE_MAX_PEER_STREAMS) { socket.destroy(); return; }
      forward.sockets.add(socket);
      void (forward.version === 2 ? this.pumpWindowed(forward, socket) : this.pump(forward, socket));
    });
    try {
      // Do not abort this request locally: a late lease result must be explicitly
      // released after cancellation, not orphaned until the remote timeout.
      const lease = await rpc.request<{ leaseId: string }>({ method: METHODS.lease, params: {
        backend: service.backend, threadId: service.threadId, serviceId: service.serviceId,
      }, timeoutMs: 5000 });
      forward.leaseId = lease.leaseId;
      if (forward.abort.signal.aborted) throw new Error("Forwarding was cancelled.");
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error): void => {
          server.off("error", failed);
          forward.abort.signal.removeEventListener("abort", cancelled);
          if (error) reject(error);
          else resolve();
        };
        const failed = (error: Error): void => finish(error);
        const cancelled = (): void => finish(new Error("Forwarding was cancelled."));
        server.once("error", failed);
        forward.abort.signal.addEventListener("abort", cancelled, { once: true });
        server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => finish());
      });
      if (forward.abort.signal.aborted) throw new Error("Forwarding was cancelled.");
      server.on("error", () => this.disconnect(windowId, forward.view.forwardId));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local service listener is unavailable.");
      forward.view.localPort = address.port;
      if (service.protocol !== "tcp") forward.view.url = `${service.protocol}://127.0.0.1:${address.port}/`;
      forward.renewal = setInterval(() => { void this.renew(forward); }, 10_000);
      forward.renewal.unref();
      return { ...forward.view };
    } catch (error) {
      this.cleanup(forward);
      throw error;
    }
  }

  disconnect(windowId: number, forwardId: string): void {
    const forward = this.forwards.get(forwardId);
    if (!forward) return;
    if (forward.windowId !== windowId) throw new Error("Forward belongs to another window.");
    this.cleanup(forward);
  }

  leave(windowId: number, thread?: ServiceThread, instanceId?: string): void {
    for (const forward of this.forwards.values()) {
      if (forward.windowId === windowId && (!thread || (forward.view.service.backend === thread.backend
        && forward.view.service.threadId === thread.threadId && forward.view.service.ownerInstanceId === instanceId))) this.cleanup(forward);
    }
  }
  disconnectPeer(instanceId: string): void {
    for (const forward of this.forwards.values()) if (forward.view.service.ownerInstanceId === instanceId) this.cleanup(forward);
    this.schedulers.delete(instanceId);
  }

  private scheduler(ownerInstanceId: string): ServiceStreamScheduler {
    let scheduler = this.schedulers.get(ownerInstanceId);
    if (!scheduler) this.schedulers.set(ownerInstanceId, scheduler = new ServiceStreamScheduler());
    return scheduler;
  }
  dispose(): void { for (const forward of this.forwards.values()) this.cleanup(forward); }

  private cleanup(forward: Forward): void {
    this.forwards.delete(forward.view.forwardId);
    clearInterval(forward.renewal);
    forward.abort.abort();
    for (const socket of forward.sockets) socket.destroy();
    forward.server.close();
    if (forward.leaseId) {
      const leaseId = forward.leaseId;
      forward.leaseId = undefined;
      void forward.rpc.request({ method: METHODS.release, params: { leaseId }, timeoutMs: 3000 }).catch(() => undefined);
    }
  }

  private async renew(forward: Forward): Promise<void> {
    if (forward.renewing || forward.abort.signal.aborted) return;
    forward.renewing = true;
    try {
      if (forward.version === 2) {
        try {
          // Naming the live streams keeps idle ones open and lets the owner reap leaks.
          await forward.rpc.request({ method: V2.renew, params: { leaseId: forward.leaseId, streamIds: [...forward.streams] },
            timeoutMs: 5000, signal: forward.abort.signal });
          return;
        } catch (error) {
          if (!unsupported(error)) throw error;
        }
      }
      await forward.rpc.request({ method: METHODS.renew, params: { leaseId: forward.leaseId }, timeoutMs: 5000, signal: forward.abort.signal });
    } catch { this.cleanup(forward); }
    finally { forward.renewing = false; }
  }

  /** Windowed stream: frames flow as credit allows, with no exchange per chunk. */
  private async pumpWindowed(forward: Forward, socket: Socket): Promise<void> {
    const streamId = randomUUID();
    const endpoint = new ServiceStreamEndpoint({
      streamId, socket, scheduler: this.scheduler(forward.view.service.ownerInstanceId), budget: this.budget,
      window: this.options.streamWindow, frameBytes: this.options.streamFrameBytes,
      send: forward.rpc.notify!.bind(forward.rpc),
      sendData: forward.rpc.sendServiceData!.bind(forward.rpc),
      onTransfer: (sent, received) => {
        forward.view.sentBytes += sent;
        forward.view.receivedBytes += received;
        if (received) forward.view.error = undefined;
      },
      onClosed: (error) => {
        this.streams.delete(streamId);
        forward.streams.delete(streamId);
        forward.sockets.delete(socket);
        if (error && !forward.abort.signal.aborted) forward.view.error = error;
      },
    });
    // Register first: the owner may push data before its open result arrives.
    this.streams.set(streamId, { forward, endpoint });
    forward.streams.add(streamId);
    try {
      const params: ServiceStreamOpen = { leaseId: forward.leaseId!, streamId, window: endpoint.initialWindow, frameBytes: endpoint.frameBytes };
      const opened = await forward.rpc.request<ServiceStreamOpened>({ method: V2.open, params, timeoutMs: 6000 });
      if (!opened || typeof opened !== "object") throw new Error("Invalid service stream response.");
      endpoint.start(opened.window, opened.frameBytes);
    } catch (error) {
      if (unsupported(error) && !endpoint.isClosed && !forward.abort.signal.aborted) {
        // An older owner or gateway: carry this socket and every later one on v1.
        forward.version = 1;
        endpoint.detach();
        this.streams.delete(streamId);
        forward.streams.delete(streamId);
        await this.pump(forward, socket);
        return;
      }
      if (!endpoint.isClosed && !forward.abort.signal.aborted) {
        forward.view.error = error instanceof Error ? error.message : "Service connection failed.";
      }
      endpoint.abort(forward.view.error ?? "Service connection cancelled.");
    }
  }

  private async pump(forward: Forward, socket: Socket): Promise<void> {
    let streamId: string | undefined;
    let seq = 0;
    const abort = new AbortController();
    const cancel = (): void => { abort.abort(); };
    socket.once("close", cancel);
    forward.abort.signal.addEventListener("abort", cancel, { once: true });
    try {
      const opened = await forward.rpc.request<{ streamId: string }>({ method: METHODS.open,
        params: { leaseId: forward.leaseId }, timeoutMs: 6000 });
      streamId = opened.streamId;
      let remoteFin = false;
      let ownerWritable: boolean = true;
      let writing = false;
      let flushed: Promise<void> | undefined;
      let finSent = false;
      let writeError: unknown;
      while (!abort.signal.aborted) {
        if (writeError) throw writeError;
        // A pending local write withholds receive credit. With nothing to upload
        // either, the exchange would carry nothing: wait for the write or local data.
        // Without owner credit, keep polling: that is how the credit comes back.
        const uploadPending = socket.readableLength > 0 || (socket.readableEnded && !finSent);
        if (flushed && ownerWritable && !uploadPending && !socket.destroyed) {
          await waitServiceReadable(socket, 50, flushed);
          continue;
        }
        const data: Buffer = ownerWritable ? readServiceData(socket) : Buffer.alloc(0);
        const fin: boolean = ownerWritable && socket.readableEnded;
        const result: ServiceExchangeResult = await forward.rpc.request<ServiceExchangeResult>({ method: METHODS.exchange,
          params: { streamId, seq, data: data.toString("base64"), fin, receive: !writing }, timeoutMs: 10_000, signal: abort.signal });
        if (result.seq !== seq || typeof result.fin !== "boolean" || typeof result.writable !== "boolean" || (remoteFin && !result.fin)) throw new Error("Invalid service response sequence.");
        const received = decodeServiceData(result.data);
        if (remoteFin && received.length) throw new Error("Service sent data after FIN.");
        if (received.length || (result.fin && !socket.writableEnded && !writing)) {
          if (writing) throw new Error("Service exceeded viewer receive credit.");
          writing = true;
          flushed = writeServiceData(socket, received, result.fin)
            .catch((error: unknown) => { writeError = error; })
            .finally(() => { writing = false; flushed = undefined; });
        }
        if (received.length) forward.view.error = undefined;
        forward.view.sentBytes += data.length;
        forward.view.receivedBytes += received.length;
        finSent ||= fin;
        remoteFin = result.fin;
        const creditReturned = result.writable && !ownerWritable;
        ownerWritable = result.writable;
        seq += 1;
        if (fin && remoteFin && !writing) break;
        // Even an ended remote readable must not cause an idle busy loop. Returned
        // write credit is progress: the next exchange can carry the queued upload.
        if (!data.length && !received.length && !creditReturned) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      if (!abort.signal.aborted) forward.view.error = error instanceof Error ? error.message : "Service connection failed.";
    } finally {
      socket.off("close", cancel);
      forward.abort.signal.removeEventListener("abort", cancel);
      forward.sockets.delete(socket);
      socket.destroy();
      if (streamId) void forward.rpc.request({ method: METHODS.close, params: { streamId }, timeoutMs: 3000 }).catch(() => undefined);
    }
  }
}
