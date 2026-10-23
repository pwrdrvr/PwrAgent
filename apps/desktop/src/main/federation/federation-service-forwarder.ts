import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import type {
  ServiceForward, ServiceThread, ThreadService, ServiceExchangeResult,
} from "@pwragent/shared";
import { FEDERATION_SERVICE_METHODS as METHODS } from "@pwragent/shared";
import {
  decodeServiceData, readServiceData, writeServiceData, SERVICE_MAX_PEER_STREAMS,
} from "./federation-service-socket";

export type ServiceRpc = {
  request<T>(params: { method: string; params: unknown; timeoutMs?: number; signal?: AbortSignal }): Promise<T>;
};
type Forward = {
  windowId: number; view: ServiceForward; rpc: ServiceRpc; server: Server;
  abort: AbortController; sockets: Set<Socket>; leaseId?: string;
  renewal?: ReturnType<typeof setInterval>; renewing: boolean;
};

/** Viewer-owned listeners; never binds any interface except literal IPv4 loopback. */
export class FederationServiceForwarder {
  private readonly forwards = new Map<string, Forward>();

  list(windowId: number, instanceId: string, thread: ServiceThread): ServiceForward[] {
    return [...this.forwards.values()].filter((entry) => entry.windowId === windowId
      && entry.view.service.ownerInstanceId === instanceId
      && entry.view.service.backend === thread.backend && entry.view.service.threadId === thread.threadId)
      .map((entry) => ({ ...entry.view, service: { ...entry.view.service } }));
  }

  async connect(windowId: number, service: ThreadService, rpc: ServiceRpc): Promise<ServiceForward> {
    const existing = this.list(windowId, service.ownerInstanceId, service).find((entry) => entry.service.serviceId === service.serviceId);
    if (existing?.localPort === 0) throw new Error("Service connection is already pending.");
    if (existing) return existing;
    if (this.forwards.size >= 16) throw new Error("Local forwarding limit reached.");
    const server = createServer({ allowHalfOpen: true, highWaterMark: 32 * 1024, pauseOnConnect: true });
    const forward: Forward = {
      windowId, view: { forwardId: randomUUID(), service, localPort: 0, sentBytes: 0, receivedBytes: 0 },
      rpc, server, abort: new AbortController(), sockets: new Set(), renewing: false,
    };
    this.forwards.set(forward.view.forwardId, forward);
    server.maxConnections = SERVICE_MAX_PEER_STREAMS;
    server.on("connection", (socket) => {
      socket.on("error", () => { /* pump owns the surfaced error and cleanup */ });
      if (forward.abort.signal.aborted || forward.sockets.size >= SERVICE_MAX_PEER_STREAMS) { socket.destroy(); return; }
      forward.sockets.add(socket);
      void this.pump(forward, socket);
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
      await forward.rpc.request({ method: METHODS.renew, params: { leaseId: forward.leaseId }, timeoutMs: 5000, signal: forward.abort.signal });
    } catch { this.cleanup(forward); }
    finally { forward.renewing = false; }
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
      let writeError: unknown;
      while (!abort.signal.aborted) {
        if (writeError) throw writeError;
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
          void writeServiceData(socket, received, result.fin)
            .catch((error: unknown) => { writeError = error; })
            .finally(() => { writing = false; });
        }
        if (received.length) forward.view.error = undefined;
        forward.view.sentBytes += data.length;
        forward.view.receivedBytes += received.length;
        remoteFin = result.fin;
        ownerWritable = result.writable;
        seq += 1;
        if (fin && remoteFin && !writing) break;
        // Even an ended remote readable must not cause an idle busy loop.
        if (!data.length && !received.length) await new Promise<void>((resolve) => setTimeout(resolve, 10));
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
