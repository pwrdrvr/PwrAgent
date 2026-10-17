import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import type {
  AdvertiseServiceArgs, FederationCapability, ServiceThread, ThreadService,
  ServiceExchange, ServiceExchangeResult,
} from "@pwragent/shared";
import { FEDERATION_SERVICE_METHODS, FEDERATION_SERVICE_CAPABILITY, isAppServerBackendKind } from "@pwragent/shared";
import type { FederationRouter } from "./federation-router";
import {
  decodeServiceData, readServiceData, waitServiceReadable, writeServiceData,
  SERVICE_LEASE_MS, SERVICE_MAX_STREAMS, SERVICE_MAX_PEER_STREAMS,
} from "./federation-service-socket";

export const SERVICE_METHOD_CAPABILITIES = Object.fromEntries(
  Object.values(FEDERATION_SERVICE_METHODS).map((method) => [method, FEDERATION_SERVICE_CAPABILITY]),
) as Record<string, FederationCapability>;

type Lease = { leaseId: string; peerId: string; service: ThreadService; expiresAt: number };
type Stream = {
  streamId: string; lease: Lease; socket: Socket; seq: number; busy: boolean;
  touchedAt: number; writing: boolean; error?: string;
};

export function serviceThread(value: unknown): ServiceThread {
  const input = value as Partial<ServiceThread> | undefined;
  if (!input || (typeof input.backend !== "string" || !isAppServerBackendKind(input.backend)) || typeof input.threadId !== "string"
    || !input.threadId.trim() || input.threadId.length > 256) throw new Error("Invalid service thread.");
  return { backend: input.backend, threadId: input.threadId };
}

export function parseServiceAdvertisement(value: unknown): AdvertiseServiceArgs {
  const input = value as AdvertiseServiceArgs;
  if (!input || typeof input !== "object"
    || Object.keys(input).some((key) => !["port", "name", "protocol", "address", "description", "ttlSeconds"].includes(key))
    || !Number.isInteger(input.port) || input.port < 1024 || input.port > 65535
    || typeof input.name !== "string" || !input.name.trim() || input.name.length > 80
    || !["http", "https", "tcp"].includes(input.protocol)
    || (input.address !== undefined && input.address !== "127.0.0.1" && input.address !== "::1")
    || (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 240))
    || (input.ttlSeconds !== undefined && (!Number.isInteger(input.ttlSeconds) || input.ttlSeconds < 60 || input.ttlSeconds > 86400))) {
    throw new Error("Declare a named HTTP, HTTPS, or TCP service on literal loopback port 1024–65535; expiry must be 60–86400 seconds.");
  }
  return input;
}

function sameThread(left: ServiceThread, right: ServiceThread): boolean {
  return left.backend === right.backend && left.threadId === right.threadId;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 128) throw new Error("Invalid service identifier.");
  return value;
}

/** Owner-side allowlist. No persistent state, DNS resolution, or agent-controlled destination in tunnel RPCs. */
export class FederationServices {
  private readonly services = new Map<string, ThreadService>();
  private readonly leases = new Map<string, Lease>();
  private readonly streams = new Map<string, Stream>();
  private readonly sessionId = randomUUID();
  private readonly timer: ReturnType<typeof setInterval>;
  private nextQuantumAt = 0;
  private disposed = false;
  private checking = false;
  private nextThreadCheckAt = 0;

  constructor(private readonly options: {
    instanceId: string;
    threadExists: (thread: ServiceThread) => Promise<boolean>;
    now?: () => number;
    blockedPorts?: () => readonly number[];
  }) {
    this.timer = setInterval(() => { void this.reap(); }, 1000);
    this.timer.unref();
  }

  async advertise(threadInput: ServiceThread, argsInput: AdvertiseServiceArgs): Promise<ThreadService> {
    const thread = serviceThread(threadInput);
    const args = parseServiceAdvertisement(argsInput);
    if (!await this.options.threadExists(thread) || this.disposed) throw new Error("Service thread is unavailable.");
    if (this.options.blockedPorts?.().includes(args.port)) throw new Error("Federation control ports cannot be advertised.");
    const address = args.address ?? "127.0.0.1";
    const previous = [...this.services.values()].find((entry) => sameThread(entry, thread)
      && entry.port === args.port && entry.address === address);
    if (!previous && this.services.size >= 64) throw new Error("Service declaration limit reached.");
    if (previous && previous.protocol !== args.protocol) this.remove(thread, previous.serviceId);
    const record: ThreadService = {
      ...thread, serviceId: previous?.protocol === args.protocol ? previous.serviceId : randomUUID(),
      ownerInstanceId: this.options.instanceId, ownerSessionId: this.sessionId,
      address, port: args.port, name: args.name.trim(), description: args.description ?? "",
      protocol: args.protocol, createdAt: previous?.createdAt ?? this.now(),
      expiresAt: this.now() + (args.ttlSeconds ?? 3600) * 1000,
    };
    this.services.set(record.serviceId, record);
    return { ...record };
  }

  async list(threadInput: ServiceThread): Promise<ThreadService[]> {
    const thread = serviceThread(threadInput);
    this.prune();
    // Ordinary thread viewers poll too. Only declarations need authoritative
    // membership checks; an empty inventory must not scan provider history.
    if (![...this.services.values()].some((entry) => sameThread(entry, thread))) return [];
    if (!await this.options.threadExists(thread)) {
      for (const service of this.services.values()) if (sameThread(service, thread)) this.remove(thread, service.serviceId);
      return [];
    }
    this.prune();
    return [...this.services.values()].filter((entry) => sameThread(entry, thread)).map((entry) => ({ ...entry }));
  }

  remove(threadInput: ServiceThread, serviceId: string): void {
    const thread = serviceThread(threadInput);
    const service = this.services.get(id(serviceId));
    if (!service) return;
    if (!sameThread(service, thread)) throw new Error("Service does not belong to this thread.");
    this.services.delete(serviceId);
    for (const lease of this.leases.values()) if (lease.service.serviceId === serviceId) this.release(lease.peerId, lease.leaseId);
  }

  async lease(peerId: string, thread: ServiceThread, serviceId: string): Promise<{ leaseId: string }> {
    const service = (await this.list(thread)).find((entry) => entry.serviceId === id(serviceId));
    if (!service || this.disposed) throw new Error("Service is no longer advertised.");
    if (this.leases.size >= 64 || [...this.leases.values()].filter((entry) => entry.peerId === peerId).length >= 16) {
      throw new Error("Service forwarding lease limit reached.");
    }
    const leaseId = randomUUID();
    this.leases.set(leaseId, { leaseId, service, peerId, expiresAt: this.now() + SERVICE_LEASE_MS });
    return { leaseId };
  }

  renew(peerId: string, leaseId: string): void {
    this.getLease(peerId, leaseId).expiresAt = this.now() + SERVICE_LEASE_MS;
  }

  release(peerId: string, leaseId: string): void {
    const lease = this.leases.get(id(leaseId));
    if (!lease) return;
    if (lease.peerId !== peerId) throw new Error("Service lease belongs to another viewer.");
    this.leases.delete(leaseId);
    for (const stream of this.streams.values()) if (stream.lease === lease) this.close(peerId, stream.streamId);
  }

  async open(peerId: string, leaseId: string): Promise<{ streamId: string }> {
    const lease = this.getLease(peerId, leaseId);
    if (this.streams.size >= SERVICE_MAX_STREAMS
      || [...this.streams.values()].filter((entry) => entry.lease.peerId === peerId).length >= SERVICE_MAX_PEER_STREAMS) {
      throw new Error("Service stream limit reached.");
    }
    const socket = new Socket({ allowHalfOpen: true });
    const stream: Stream = { streamId: randomUUID(), lease, socket, seq: 0, busy: false, writing: false, touchedAt: this.now() };
    this.streams.set(stream.streamId, stream);
    socket.on("error", () => { stream.error = "Service connection failed or stopped."; });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { socket.destroy(); reject(new Error("Service connection timed out.")); }, 5000);
        const cleanup = (): void => { clearTimeout(timer); socket.off("connect", connected); socket.off("error", failed); socket.off("close", closed); };
        const connected = (): void => {
          cleanup();
          if (socket.remoteAddress !== lease.service.address) { socket.destroy(); reject(new Error("Service target was not the declared loopback address.")); }
          else resolve();
        };
        const failed = (): void => { cleanup(); reject(new Error("Service is not accepting connections.")); };
        const closed = (): void => { cleanup(); reject(new Error("Service connection cancelled.")); };
        socket.once("connect", connected); socket.once("error", failed); socket.once("close", closed);
        socket.connect({ host: lease.service.address, port: lease.service.port, family: lease.service.address === "::1" ? 6 : 4 });
      });
      this.getLease(peerId, leaseId);
      return { streamId: stream.streamId };
    } catch (error) {
      this.close(peerId, stream.streamId);
      throw error;
    }
  }

  async exchange(peerId: string, input: ServiceExchange): Promise<ServiceExchangeResult> {
    const stream = this.getStream(peerId, input.streamId);
    if (stream.busy) throw new Error("Concurrent service exchanges are forbidden.");
    stream.busy = true;
    try {
      if (input.seq !== stream.seq || !Number.isSafeInteger(input.seq) || typeof input.fin !== "boolean" || typeof input.receive !== "boolean") {
        throw new Error("Invalid service exchange sequence.");
      }
      const bytes = decodeServiceData(input.data);
      // One reservation per live stream. A global 4ms quantum bounds service traffic
      // to ~4 MiB/s in either direction and yields to control-plane tasks.
      const at = Math.max(Date.now(), this.nextQuantumAt);
      this.nextQuantumAt = at + 4;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, at - Date.now())));
      this.getLease(peerId, stream.lease.leaseId);
      if (stream.error) throw new Error(stream.error);
      if (bytes.length || (input.fin && !stream.socket.writableEnded)) {
        if (stream.writing) throw new Error("Service write credit exceeded.");
        stream.writing = true;
        // Independent directional credit prevents full-duplex deadlocks: keep
        // draining the opposite direction while a socket write is blocked.
        void writeServiceData(stream.socket, bytes, input.fin)
          .catch(() => { stream.error = "Service socket write failed or stalled."; })
          .finally(() => { stream.writing = false; });
      }
      if (input.receive) await waitServiceReadable(stream.socket);
      this.getLease(peerId, stream.lease.leaseId);
      if (stream.error) throw new Error(stream.error);
      const data = input.receive ? readServiceData(stream.socket) : Buffer.alloc(0);
      const fin = stream.socket.readableEnded;
      stream.seq += 1;
      stream.touchedAt = this.now();
      return { seq: input.seq, data: data.toString("base64"), fin, writable: !stream.writing };
    } catch (error) {
      this.close(peerId, stream.streamId);
      throw error;
    } finally { stream.busy = false; }
  }

  close(peerId: string, streamId: string): void {
    const stream = this.streams.get(id(streamId));
    if (!stream) return;
    if (stream.lease.peerId !== peerId) throw new Error("Service stream belongs to another viewer.");
    this.streams.delete(streamId);
    stream.socket.destroy();
  }

  disconnect(peerId: string): void {
    for (const lease of this.leases.values()) if (lease.peerId === peerId) this.release(peerId, lease.leaseId);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
    for (const lease of this.leases.values()) this.release(lease.peerId, lease.leaseId);
    this.services.clear();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private getLease(peerId: string, leaseId: string): Lease {
    const lease = this.leases.get(id(leaseId));
    if (!lease || lease.peerId !== peerId || lease.expiresAt <= this.now()
      || (this.services.get(lease.service.serviceId)?.expiresAt ?? 0) <= this.now()) throw new Error("Service forwarding permission expired or was revoked.");
    return lease;
  }
  private getStream(peerId: string, streamId: string): Stream {
    const stream = this.streams.get(id(streamId));
    if (!stream) throw new Error("Service stream is closed.");
    this.getLease(peerId, stream.lease.leaseId);
    return stream;
  }
  private prune(): void {
    for (const service of this.services.values()) if (service.expiresAt <= this.now()) this.remove(service, service.serviceId);
    for (const lease of this.leases.values()) if (lease.expiresAt <= this.now()) this.release(lease.peerId, lease.leaseId);
    for (const stream of this.streams.values()) if (stream.touchedAt + SERVICE_LEASE_MS <= this.now()) this.close(stream.lease.peerId, stream.streamId);
  }
  private async reap(): Promise<void> {
    this.prune();
    if (this.checking || this.now() < this.nextThreadCheckAt) return;
    this.nextThreadCheckAt = this.now() + 10_000;
    this.checking = true;
    try {
      const threads = new Map([...this.services.values()].map((service) => [`${service.backend}:${service.threadId}`, service]));
      for (const thread of threads.values()) {
        if (!await this.options.threadExists(thread)) {
          for (const service of this.services.values()) if (sameThread(service, thread)) this.remove(thread, service.serviceId);
        }
      }
    } catch { /* A transient backend failure does not extend expiry. */ }
    finally { this.checking = false; }
  }
}

export function registerFederationServices(router: FederationRouter, service: FederationServices): void {
  for (const [action, method] of Object.entries(FEDERATION_SERVICE_METHODS)) {
    router.registerHandler(method, (envelope) => {
      const peerId = id(envelope.sourceInstanceId);
      const args = envelope.params as Record<string, unknown>;
      if (!args || typeof args !== "object") throw new Error("Invalid service request.");
      switch (action) {
        case "list": return service.list(serviceThread(args));
        case "remove": return service.remove(serviceThread(args), id(args.serviceId));
        case "lease": return service.lease(peerId, serviceThread(args), id(args.serviceId));
        case "renew": return service.renew(peerId, id(args.leaseId));
        case "release": return service.release(peerId, id(args.leaseId));
        case "open": return service.open(peerId, id(args.leaseId));
        case "exchange": return service.exchange(peerId, args as ServiceExchange);
        case "close": return service.close(peerId, id(args.streamId));
      }
    });
  }
}
