import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type {
  AgentNotificationItem,
  AgentNotificationsSnapshot,
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import type { WindowShowThreadRequest } from "../../shared/window-show-thread";

const NATIVE_BODY_MAX_CHARS = 220;
const EMPTY: AgentNotificationsSnapshot = { unread: [], scheduled: [], earlier: [] };

export type AgentNotificationPeer = { target: FederationRemoteTarget; label: string };

export type FederatedAgentNotificationDependencies = {
  /** This machine's own notices. */
  local: (request: ManageAgentNotificationsRequest) => Promise<ManageAgentNotificationsResponse>;
  /** A peer's notices, read or changed on the peer. */
  remote: (target: FederationRemoteTarget, request: ManageAgentNotificationsRequest) => Promise<ManageAgentNotificationsResponse>;
  /** Connected peers that share their notices. */
  peers: () => AgentNotificationPeer[];
  /** Follow exactly these peers' notice events. */
  watch: (instanceIds: string[]) => void;
  nativeNotificationsEnabled: () => boolean;
  notifyNative: (params: { enabled: boolean; key: string; title: string; body: string; onShow?: () => void }) => void;
  clearNative: (key: string) => void;
  showThread: (request: WindowShowThreadRequest) => void;
  /** Tells this machine's windows to read their notices again. */
  changed: () => void;
  warn?: (message: string, fields: Record<string, unknown>) => void;
};

type OwnerState = {
  peer: AgentNotificationPeer;
  snapshot: AgentNotificationsSnapshot;
  /** Unread notices already announced; the first read after connecting announces none. */
  announced: Set<string> | undefined;
  reading?: Promise<void>;
  stale: boolean;
  /** Requests sent to this peer, numbered in order. */
  sent: number;
  /** The newest request whose reply is stored. */
  applied: number;
};

/**
 * A viewer's copy of its peers' agent notices. Each peer keeps its notices,
 * their schedule, bounds and read state; this keeps the last snapshot each
 * connected peer sent and reads it again when the peer says it changed.
 *
 * Every window that can see a peer's threads shows its notices: a main
 * window shows this machine's and every connected peer's, a peer's window
 * shows that peer's. This machine raises one native notification per new
 * notice, under the same eligibility as its own. Notices unread when a peer
 * connects are listed, not announced.
 *
 * Every read, dismiss and cancel reply carries the peer's whole snapshot.
 * Requests reach the peer in the order they were sent, on the one connection
 * to it, but replies can come back in any order. Each request is numbered
 * when it is sent, and a reply older than the one stored is dropped: storing
 * it would bring back a dismissed notice, or announce one twice.
 */
export class FederatedAgentNotifications {
  private readonly owners = new Map<string, OwnerState>();

  constructor(private readonly deps: FederatedAgentNotificationDependencies) {}

  /** Follows the peers connected now and forgets the rest. */
  syncPeers(): void {
    const peers = this.deps.peers();
    const connected = new Set(peers.map((peer) => peer.target.instanceId));
    let dropped = false;
    for (const [instanceId, owner] of this.owners) {
      if (connected.has(instanceId)) continue;
      this.owners.delete(instanceId);
      for (const id of owner.announced ?? []) this.deps.clearNative(nativeKey(instanceId, id));
      dropped ||= hasItems(owner.snapshot);
    }
    const added: string[] = [];
    for (const peer of peers) {
      const owner = this.owners.get(peer.target.instanceId);
      if (owner) {
        owner.peer = peer;
        continue;
      }
      this.owners.set(peer.target.instanceId, { peer, snapshot: EMPTY, announced: undefined, stale: false, sent: 0, applied: 0 });
      added.push(peer.target.instanceId);
    }
    this.deps.watch([...connected]);
    if (dropped) this.deps.changed();
    for (const instanceId of added) void this.refresh(instanceId);
  }

  /** A peer's notices changed, or its event stream restarted. */
  onRemoteEvent(event: AgentEvent): void {
    const target = event.federationTarget;
    if (target?.scope !== "remote") return;
    const method = event.notification.method;
    if (method !== "agentNotifications/updated" && method !== "federation/eventStream/changed") return;
    if (this.owners.has(target.instanceId)) void this.refresh(target.instanceId);
  }

  /** Reads a peer's notices again; one read at a time, plus one after it. */
  async refresh(instanceId: string): Promise<void> {
    const owner = this.owners.get(instanceId);
    if (!owner) return;
    if (owner.reading) {
      owner.stale = true;
      return await owner.reading;
    }
    owner.reading = (async () => {
      do {
        owner.stale = false;
        await this.read(owner);
      } while (owner.stale && this.owners.get(instanceId) === owner);
    })().finally(() => {
      owner.reading = undefined;
    });
    return await owner.reading;
  }

  /** What one window shows: a main window passes no target. */
  async snapshot(window: FederationRemoteTarget | undefined): Promise<ManageAgentNotificationsResponse> {
    if (window) return { ok: true, snapshot: this.owners.get(window.instanceId)?.snapshot ?? EMPTY };
    const local = await this.deps.local({ action: "snapshot" });
    // Peers' notices still show while this machine's are not available yet.
    if (!local.ok && this.owners.size === 0) return local;
    return { ok: true, snapshot: this.merged(local.ok ? local.snapshot : EMPTY) };
  }

  async manage(
    request: ManageAgentNotificationsRequest,
    window: FederationRemoteTarget | undefined,
  ): Promise<ManageAgentNotificationsResponse> {
    if (!request || typeof request !== "object") {
      return { ok: false, error: { code: "invalid_request", message: "Unknown request." } };
    }
    if (request.action === "snapshot") return await this.snapshot(window);
    if (request.action === "dismiss_all") {
      const owners = window ? [window.instanceId] : [...this.owners.keys()];
      // Only the notices the window listed, each on its own owner. This
      // machine's notices and each peer's are dismissed independently.
      const listed = Array.isArray(request.ids) ? request.ids : undefined;
      const local = window ? undefined : await this.deps.local(listed
        ? { action: "dismiss_all", ids: listed.filter((ref) => !ref.federationTarget) }
        : request);
      await Promise.all(owners.map(async (instanceId) => {
        const owner = this.owners.get(instanceId);
        const ids = listed?.filter((ref) => ref.federationTarget?.instanceId === instanceId).map((ref) => ({ id: ref.id }));
        if (!owner || (ids ? ids.length === 0 : owner.snapshot.unread.length === 0)) return;
        try {
          const { seq, response } = await this.ask(owner, ids ? { action: "dismiss_all", ids } : { action: "dismiss_all" });
          this.apply(owner, response, seq);
        } catch (error) {
          // One unreachable peer keeps its notices; the others are dismissed.
          this.deps.warn?.("peer agent notices not dismissed", {
            instanceId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }));
      this.deps.changed();
      if (local && !local.ok) return local;
      return await this.snapshot(window);
    }
    // A peer's window acts only on its own peer's notices.
    const target = request.federationTarget ?? window;
    if (window && target?.instanceId !== window.instanceId) {
      return { ok: false, error: { code: "invalid_request", message: "That notice belongs to another machine." } };
    }
    if (!target) {
      const local = await this.deps.local(request);
      return local.ok ? { ok: true, snapshot: this.merged(local.snapshot) } : local;
    }
    const owner = this.owners.get(target.instanceId);
    if (!owner) {
      return { ok: false, error: { code: "unavailable", message: "That machine is not connected." } };
    }
    const { seq, response } = await this.ask(owner, { ...request, federationTarget: undefined });
    if (!response.ok) return response;
    this.apply(owner, response, seq);
    this.deps.changed();
    return await this.snapshot(window);
  }

  /** Sends one request to a peer, numbered in the order requests leave. */
  private async ask(
    owner: OwnerState,
    request: ManageAgentNotificationsRequest,
  ): Promise<{ seq: number; response: ManageAgentNotificationsResponse }> {
    const seq = ++owner.sent;
    return { seq, response: await this.deps.remote(owner.peer.target, request) };
  }

  private async read(owner: OwnerState): Promise<void> {
    let seq: number;
    let response: ManageAgentNotificationsResponse;
    try {
      ({ seq, response } = await this.ask(owner, { action: "snapshot" }));
    } catch (error) {
      // Keep the last snapshot through an outage; the reconnect reads again.
      this.deps.warn?.("peer agent notices unavailable", {
        instanceId: owner.peer.target.instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!response.ok) {
      this.deps.warn?.("peer agent notices refused", { instanceId: owner.peer.target.instanceId, code: response.error.code });
      return;
    }
    if (this.apply(owner, response, seq)) this.deps.changed();
  }

  /**
   * Stores a peer's snapshot and announces the notices it newly holds
   * unread. A reply to an older request than the stored one is dropped; the
   * stored snapshot is newer. So is a reply for a peer this viewer has since
   * dropped: its banners were withdrawn, and nothing would withdraw new ones.
   */
  private apply(owner: OwnerState, response: ManageAgentNotificationsResponse, seq: number): boolean {
    if (!response.ok || seq <= owner.applied || this.owners.get(owner.peer.target.instanceId) !== owner) return false;
    owner.applied = seq;
    const { target, label } = owner.peer;
    const tag = (item: AgentNotificationItem): AgentNotificationItem => ({ ...item, federationTarget: target, ownerLabel: label });
    const snapshot: AgentNotificationsSnapshot = {
      unread: response.snapshot.unread.map(tag),
      scheduled: response.snapshot.scheduled.map(tag),
      earlier: response.snapshot.earlier.map(tag),
    };
    const unread = new Set(snapshot.unread.map((item) => item.id));
    const announced = owner.announced;
    owner.snapshot = snapshot;
    owner.announced = unread;
    if (!announced) return true;
    for (const id of announced) {
      if (!unread.has(id)) this.deps.clearNative(nativeKey(target.instanceId, id));
    }
    for (const item of snapshot.unread) {
      if (announced.has(item.id)) continue;
      const where = [item.threadTitle, label].filter(Boolean).join(" on ");
      this.deps.notifyNative({
        enabled: this.deps.nativeNotificationsEnabled(),
        key: nativeKey(target.instanceId, item.id),
        title: item.title,
        body: clip(where ? `${where} · ${item.body}` : item.body, NATIVE_BODY_MAX_CHARS),
        onShow: () => {
          this.deps.showThread({ backend: item.backend, threadId: item.threadId, federationTarget: target });
          void this.manage({ action: "dismiss", id: item.id, federationTarget: target }, undefined).catch(() => undefined);
        },
      });
    }
    return true;
  }

  private merged(local: AgentNotificationsSnapshot): AgentNotificationsSnapshot {
    if (this.owners.size === 0) return local;
    const all = [local, ...[...this.owners.values()].map((owner) => owner.snapshot)];
    const newestFirst = (left: AgentNotificationItem, right: AgentNotificationItem) =>
      (right.deliveredAt ?? right.scheduledFor) - (left.deliveredAt ?? left.scheduledFor);
    return {
      unread: all.flatMap((snapshot) => snapshot.unread).sort(newestFirst),
      scheduled: all.flatMap((snapshot) => snapshot.scheduled).sort((left, right) => left.scheduledFor - right.scheduledFor),
      earlier: all.flatMap((snapshot) => snapshot.earlier).sort(newestFirst),
    };
  }
}

function hasItems(snapshot: AgentNotificationsSnapshot): boolean {
  return snapshot.unread.length > 0 || snapshot.scheduled.length > 0 || snapshot.earlier.length > 0;
}

function nativeKey(instanceId: string, id: string): string {
  return `agent-notification:${instanceId}:${id}`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}
