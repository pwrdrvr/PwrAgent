import { randomUUID } from "node:crypto";
import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_SHUTDOWN_METHOD,
  isFederationShutdownNotice,
  type FederationProtocolEnvelope,
  type FederationShutdownNotice,
  type FederationPeerShutdown,
} from "@pwragent/shared";
import type { FederationRouterConnection } from "./federation-router";

/** Ephemeral control-plane state: countdown ticks never write or send traffic. */
export class FederationShutdown {
  private local?: FederationShutdownNotice;
  private readonly received = new Map<string, FederationShutdownNotice>();
  private readonly remote = new Map<string, FederationPeerShutdown>();

  constructor(private readonly options: {
    instanceId: () => string;
    connections: () => FederationRouterConnection[];
    label: (peerId: string) => string;
    changed: (notices: FederationPeerShutdown[]) => void;
    now?: () => number;
  }) {}

  get draining(): boolean { return this.local !== undefined; }

  snapshot(): FederationPeerShutdown[] { return [...this.remote.values()]; }

  begin(deadlineAt: number | null): void {
    if (this.local?.state === "scheduled" && this.local.deadlineAt === deadlineAt) return;
    this.local = {
      shutdownId: this.local?.shutdownId ?? randomUUID(),
      revision: (this.local?.revision ?? 0) + 1,
      state: "scheduled",
      reason: "quit",
      deadlineAt,
    };
    this.broadcast();
  }

  pause(): void {
    if (!this.local) return;
    this.local = { ...this.local, revision: this.local.revision + 1, deadlineAt: null };
    this.broadcast();
  }

  cancel(): void {
    if (!this.local) return;
    this.local = { ...this.local, revision: this.local.revision + 1, state: "cancelled" };
    this.broadcast();
    this.local = undefined;
  }

  exiting(): void {
    if (this.local?.state === "exiting") return;
    this.local = {
      shutdownId: this.local?.shutdownId ?? randomUUID(),
      revision: (this.local?.revision ?? 0) + 1,
      state: "exiting", reason: "quit", deadlineAt: this.now(),
    };
    this.broadcast();
  }

  connected(peerId: string): void {
    this.received.delete(peerId);
    this.disconnected(peerId);
    if (this.local) this.send(peerId);
  }

  disconnected(peerId: string): void {
    if (this.remote.delete(peerId)) this.options.changed(this.snapshot());
  }

  receive(envelope: FederationProtocolEnvelope, sourcePeerId: string): boolean {
    if (envelope.kind !== "notification" || envelope.method !== FEDERATION_SHUTDOWN_METHOD) return false;
    // A shutdown is about this authenticated socket's owner, never a relayed
    // assertion about another machine. It is independent of thread subscriptions.
    const connection = this.options.connections().find((peer) => peer.peerId === sourcePeerId);
    if (!connection?.capabilities.includes("shutdown_notice")
      || envelope.sourceInstanceId !== sourcePeerId
      || (envelope.targetInstanceId && envelope.targetInstanceId !== this.options.instanceId())
      || !Number.isFinite(envelope.createdAt)
      || !isFederationShutdownNotice(envelope.params)) return true;
    const notice = envelope.params;
    const previous = this.received.get(sourcePeerId);
    if (previous?.shutdownId === notice.shutdownId && previous.revision >= notice.revision) return true;
    if (notice.state === "cancelled" && previous?.shutdownId !== notice.shutdownId) return true;
    this.received.set(sourcePeerId, notice);
    if (notice.state === "cancelled") {
      if (previous?.shutdownId === notice.shutdownId) this.disconnected(sourcePeerId);
      return true;
    }
    // Count down from the sender's remaining duration, not its wall clock.
    const deadlineAt = notice.deadlineAt === null ? null
      : this.now() + Math.max(0, Math.min(300_000, notice.deadlineAt - envelope.createdAt));
    this.remote.set(sourcePeerId, {
      ...notice, deadlineAt, instanceId: sourcePeerId, label: this.options.label(sourcePeerId),
    });
    this.options.changed(this.snapshot());
    return true;
  }

  peerDraining(peerId: string): boolean { return this.remote.has(peerId); }

  private broadcast(): void {
    for (const peer of this.options.connections()) this.send(peer.peerId);
  }

  private send(peerId: string): void {
    const peer = this.options.connections().find((candidate) => candidate.peerId === peerId);
    if (!this.local || !peer?.capabilities.includes("shutdown_notice")) return;
    try {
      peer.sendEnvelope({
        id: `federation-shutdown:${randomUUID()}`,
        kind: "notification", method: FEDERATION_SHUTDOWN_METHOD,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.options.instanceId(), targetInstanceId: peerId,
        createdAt: this.now(), params: this.local,
      });
    } catch {
      // A disconnected or unresponsive peer must never hold quit hostage.
    }
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
}
