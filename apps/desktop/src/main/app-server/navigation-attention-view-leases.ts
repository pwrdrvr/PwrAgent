import { randomUUID } from "node:crypto";
import type { NavigationAttentionViewReleaseRequest, NavigationQueryRequest } from "@pwragent/shared";

export type NavigationAttentionViewRelease = NavigationAttentionViewReleaseRequest;
type Lease = NavigationAttentionViewRelease & { rendererViewId: string; senderId: number };

/** Renderer useId values are not globally unique. Only this process assigns owner-visible lifetimes. */
export class NavigationAttentionViewLeases {
  private readonly leases = new Map<string, Lease>();
  constructor(private readonly releaseOwner: (request: NavigationAttentionViewRelease) => Promise<void>) {}

  private key(senderId: number, request: NavigationAttentionViewRelease): string {
    return JSON.stringify([senderId, request.viewId, request.federationTarget?.scope === "remote" ? request.federationTarget.instanceId : null]);
  }

  qualify(senderId: number, request: NavigationQueryRequest): NavigationQueryRequest {
    if (!request.attentionView) return request;
    if (typeof request.attentionView.id !== "string" || !request.attentionView.id || request.attentionView.id.length > 128) {
      throw new Error("Navigation Attention requires a bounded renderer view identity.");
    }
    if (request.federationTarget?.scope === "remote" && (typeof request.federationTarget.instanceId !== "string"
      || !request.federationTarget.instanceId || request.federationTarget.instanceId.length > 128)) {
      throw new Error("Navigation Attention requires a bounded owner identity.");
    }
    const key = this.key(senderId, { viewId: request.attentionView.id, federationTarget: request.federationTarget });
    let lease = this.leases.get(key);
    if (!lease) {
      if (this.leases.size >= 256) throw new Error("Navigation Attention lifetime admission is occupied. Close an inactive view.");
      lease = { viewId: randomUUID(), rendererViewId: request.attentionView.id, senderId, federationTarget: request.federationTarget };
      if (Buffer.byteLength(JSON.stringify([...this.leases, [key, lease]]), "utf8") > 256 * 1024) {
        throw new Error("Navigation Attention lifetimes exceed their retained metadata budget.");
      }
      this.leases.set(key, lease);
    }
    return { ...request, attentionView: { ...request.attentionView, id: lease.viewId } };
  }

  getBudgetUsage(): { views: number; retainedBytes: number } {
    return { views: this.leases.size, retainedBytes: Buffer.byteLength(JSON.stringify([...this.leases]), "utf8") };
  }

  release(senderId: number, request: NavigationAttentionViewRelease): Promise<void> {
    const key = this.key(senderId, request);
    const lease = this.leases.get(key);
    if (!lease) return Promise.resolve();
    // Remove before asynchronous owner release. A new mount gets a fresh wire id.
    this.leases.delete(key);
    return this.releaseOwner({ viewId: lease.viewId, federationTarget: lease.federationTarget });
  }

  async releaseSender(senderId: number): Promise<void> {
    await Promise.allSettled([...this.leases.values()].filter((lease) => lease.senderId === senderId)
      .map((lease) => this.release(senderId, { viewId: lease.rendererViewId, federationTarget: lease.federationTarget })));
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...new Set([...this.leases.values()].map((lease) => lease.senderId))].map((senderId) => this.releaseSender(senderId)));
  }
}
