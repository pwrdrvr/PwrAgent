import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type {
  AgentNotificationItem,
  AgentNotificationsSnapshot,
  ManageAgentNotificationsRequest,
  ManageAgentNotificationsResponse,
} from "@pwragent/shared/contracts/scheduled-thread-actions";
import { FederatedAgentNotifications } from "../scheduled-actions/federated-agent-notifications";

const PEERS = ["peer-a", "peer-b"] as const;
type PeerId = (typeof PEERS)[number];

function item(id: string, scheduled = false): AgentNotificationItem {
  return {
    id,
    backend: "codex",
    threadId: `thread-${id}`,
    title: `Notice ${id}`,
    body: `Body ${id}`,
    urgency: "normal",
    status: scheduled ? "scheduled" : "started",
    scheduledFor: 1_000,
    ...(scheduled ? {} : { deliveredAt: 2_000 }),
  };
}

/** One owner's notices, as its notification center keeps them. */
class FakeOwner {
  unread: AgentNotificationItem[] = [];
  scheduled: AgentNotificationItem[] = [];

  snapshot(): AgentNotificationsSnapshot {
    return { unread: [...this.unread], scheduled: [...this.scheduled], earlier: [] };
  }

  manage(request: ManageAgentNotificationsRequest): ManageAgentNotificationsResponse {
    if (request.action === "dismiss") this.unread = this.unread.filter((entry) => entry.id !== request.id);
    if (request.action === "dismiss_all") this.unread = [];
    if (request.action === "cancel") {
      if (!this.scheduled.some((entry) => entry.id === request.id)) {
        return { ok: false, error: { code: "not_found", message: "gone" } };
      }
      this.scheduled = this.scheduled.filter((entry) => entry.id !== request.id);
    }
    return { ok: true, snapshot: this.snapshot() };
  }
}

function harness() {
  const local = new FakeOwner();
  const owners = new Map<PeerId, FakeOwner>(PEERS.map((peer) => [peer, new FakeOwner()]));
  const connected = new Set<PeerId>();
  const remoteCalls: Array<{ peer: string; request: ManageAgentNotificationsRequest }> = [];
  const notified: string[] = [];
  const cleared: string[] = [];
  let watched: string[] = [];
  let changes = 0;
  const notices = new FederatedAgentNotifications({
    local: async (request) => local.manage(request),
    remote: async (target, request) => {
      remoteCalls.push({ peer: target.instanceId, request });
      if (!connected.has(target.instanceId as PeerId)) throw new Error("disconnected");
      expect(request).not.toHaveProperty("federationTarget", expect.anything());
      return owners.get(target.instanceId as PeerId)!.manage(request);
    },
    peers: () => [...connected].map((peer) => ({ target: target(peer), label: `Label ${peer}` })),
    watch: (instanceIds) => { watched = instanceIds; },
    nativeNotificationsEnabled: () => true,
    notifyNative: ({ key }) => { notified.push(key); },
    clearNative: (key) => { cleared.push(key); },
    showThread: () => undefined,
    changed: () => { changes++; },
  });
  return {
    notices, local, owners, connected, remoteCalls, notified, cleared,
    watched: () => watched, changes: () => changes,
  };
}

function target(peer: string): FederationRemoteTarget {
  return { scope: "remote", instanceId: peer };
}

function updated(peer: string): AgentEvent {
  return {
    backend: "codex",
    federationTarget: target(peer),
    notification: { method: "agentNotifications/updated", params: { threadId: "t" } },
  } as AgentEvent;
}

/** The fakes answer at once, so reads settle within a few microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function keyOf(entry: AgentNotificationItem): string {
  return `${entry.federationTarget?.instanceId ?? "local"}:${entry.id}`;
}

async function snapshotOf(
  notices: FederatedAgentNotifications,
  window: FederationRemoteTarget | undefined,
): Promise<AgentNotificationsSnapshot> {
  const response = await notices.manage({ action: "snapshot" }, window);
  if (!response.ok) throw new Error(response.error.message);
  return response.snapshot;
}

type Op =
  | { kind: "connect" | "disconnect" | "ownerDismiss" | "viewerDismiss" | "peerWindowDismiss" | "schedule" | "viewerCancel" | "streamRestart"; peer: PeerId }
  | { kind: "deliver"; peer: PeerId }
  | { kind: "localDeliver" | "dismissAll" };

const peerOp = (...kinds: string[]) =>
  fc.record({ kind: fc.constantFrom(...kinds), peer: fc.constantFrom(...PEERS) }) as fc.Arbitrary<Op>;

// Connecting and reconnecting are weighted up: what a peer holds when the
// viewer connects is where announcing goes wrong.
const opArbitrary: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: peerOp("connect", "disconnect") },
  { weight: 3, arbitrary: peerOp("deliver") },
  { weight: 4, arbitrary: peerOp("ownerDismiss", "viewerDismiss", "peerWindowDismiss", "schedule", "viewerCancel", "streamRestart") },
  { weight: 1, arbitrary: fc.record({ kind: fc.constantFrom("localDeliver", "dismissAll") }) as fc.Arbitrary<Op> },
);

describe("FederatedAgentNotifications", () => {
  it("shows every connected owner's notices once, and announces each new one once", async () => {
    await fc.assert(fc.asyncProperty(
      fc.tuple(fc.nat(2), fc.nat(2)),
      fc.array(opArbitrary, { maxLength: 20 }),
      async (waiting, ops) => {
      const h = harness();
      // The model: what each owner holds unread when the viewer connects is
      // listed but never announced.
      const baseline = new Map<PeerId, Set<string>>();
      let next = 0;
      // Notices the peers already hold before this viewer sees them.
      PEERS.forEach((peer, index) => {
        for (let i = 0; i < waiting[index]!; i++) h.owners.get(peer)!.unread.push(item(`n${next++}`));
      });
      for (const op of ops) {
        switch (op.kind) {
          case "connect":
            if (h.connected.has(op.peer)) break;
            h.connected.add(op.peer);
            baseline.set(op.peer, new Set(h.owners.get(op.peer)!.unread.map((entry) => entry.id)));
            h.notices.syncPeers();
            break;
          case "disconnect":
            h.connected.delete(op.peer);
            baseline.delete(op.peer);
            h.notices.syncPeers();
            break;
          case "deliver":
            h.owners.get(op.peer)!.unread.push(item(`n${next++}`));
            if (h.connected.has(op.peer)) h.notices.onRemoteEvent(updated(op.peer));
            break;
          case "schedule":
            h.owners.get(op.peer)!.scheduled.push(item(`n${next++}`, true));
            if (h.connected.has(op.peer)) h.notices.onRemoteEvent(updated(op.peer));
            break;
          case "ownerDismiss": {
            const owner = h.owners.get(op.peer)!;
            owner.unread = owner.unread.slice(1);
            if (h.connected.has(op.peer)) h.notices.onRemoteEvent(updated(op.peer));
            break;
          }
          case "viewerDismiss":
          case "peerWindowDismiss": {
            const window = op.kind === "peerWindowDismiss" ? target(op.peer) : undefined;
            const shown = (await snapshotOf(h.notices, window)).unread
              .find((entry) => entry.federationTarget?.instanceId === op.peer);
            if (shown) {
              await h.notices.manage({ action: "dismiss", id: shown.id, federationTarget: shown.federationTarget }, window);
            }
            break;
          }
          case "viewerCancel": {
            const shown = (await snapshotOf(h.notices, undefined)).scheduled
              .find((entry) => entry.federationTarget?.instanceId === op.peer);
            if (shown) await h.notices.manage({ action: "cancel", id: shown.id, federationTarget: shown.federationTarget }, undefined);
            break;
          }
          case "streamRestart":
            h.notices.onRemoteEvent({ ...updated(op.peer), notification: { method: "federation/eventStream/changed", params: {} } } as AgentEvent);
            break;
          case "localDeliver":
            h.local.unread.push(item(`n${next++}`));
            break;
          case "dismissAll":
            await h.notices.manage({ action: "dismiss_all" }, undefined);
            break;
        }
        await settle();

        // A main window shows this machine's notices and every connected
        // owner's, each tagged with its owner.
        const main = await snapshotOf(h.notices, undefined);
        const expectedUnread = [
          ...h.local.unread.map((entry) => `local:${entry.id}`),
          ...[...h.connected].flatMap((peer) => h.owners.get(peer)!.unread.map((entry) => `${peer}:${entry.id}`)),
        ].sort();
        expect(main.unread.map(keyOf).sort()).toEqual(expectedUnread);
        expect(main.scheduled.map(keyOf).sort()).toEqual(
          [...h.connected].flatMap((peer) => h.owners.get(peer)!.scheduled.map((entry) => `${peer}:${entry.id}`)).sort(),
        );
        for (const entry of [...main.unread, ...main.scheduled]) {
          if (entry.federationTarget) expect(entry.ownerLabel).toBe(`Label ${entry.federationTarget.instanceId}`);
        }
        // A peer's window shows that peer's notices only.
        for (const peer of PEERS) {
          const window = await snapshotOf(h.notices, target(peer));
          expect(window.unread.map(keyOf).sort()).toEqual(
            h.connected.has(peer) ? h.owners.get(peer)!.unread.map((entry) => `${peer}:${entry.id}`).sort() : [],
          );
        }
        // Each notice that arrived while connected is announced exactly
        // once, and its banner is withdrawn when it is no longer unread.
        expect(new Set(h.notified).size).toBe(h.notified.length);
        const active = new Set(h.notified.filter((key) => !h.cleared.includes(key)));
        const expectedActive = new Set([...h.connected].flatMap((peer) => h.owners.get(peer)!.unread
          .filter((entry) => !baseline.get(peer)!.has(entry.id))
          .map((entry) => `agent-notification:${peer}:${entry.id}`)));
        expect(active).toEqual(expectedActive);
        expect([...h.watched()].sort()).toEqual([...h.connected].sort());
      }
      },
    ));
  });

  it("shows a peer's window its owner's notices", async () => {
    const h = harness();
    h.owners.get("peer-a")!.unread.push(item("waiting"));
    h.connected.add("peer-a");
    h.notices.syncPeers();
    await settle();

    const window = await snapshotOf(h.notices, target("peer-a"));
    expect(window.unread.map(keyOf)).toEqual(["peer-a:waiting"]);
  });

  it("lists, but does not announce, what was unread before the peer connected", async () => {
    const h = harness();
    h.owners.get("peer-a")!.unread.push(item("before"));
    h.connected.add("peer-a");
    h.notices.syncPeers();
    await settle();
    h.owners.get("peer-a")!.unread.push(item("after"));
    h.notices.onRemoteEvent(updated("peer-a"));
    await settle();

    expect(h.notified).toEqual(["agent-notification:peer-a:after"]);
    expect((await snapshotOf(h.notices, undefined)).unread.map(keyOf).sort()).toEqual(["peer-a:after", "peer-a:before"]);
  });

  it("dismisses a peer's notice on its owner and withdraws its banner", async () => {
    const h = harness();
    h.connected.add("peer-a");
    h.notices.syncPeers();
    await settle();
    h.owners.get("peer-a")!.unread.push(item("ping"));
    h.notices.onRemoteEvent(updated("peer-a"));
    await settle();

    const response = await h.notices.manage({ action: "dismiss", id: "ping", federationTarget: target("peer-a") }, undefined);
    expect(response.ok).toBe(true);
    expect(h.owners.get("peer-a")!.unread).toEqual([]);
    expect(h.cleared).toEqual(["agent-notification:peer-a:ping"]);
  });

  it("refuses a peer's window acting on another machine's notice", async () => {
    const h = harness();
    h.connected.add("peer-a");
    h.connected.add("peer-b");
    h.notices.syncPeers();
    await settle();

    const response = await h.notices.manage(
      { action: "cancel", id: "x", federationTarget: target("peer-b") },
      target("peer-a"),
    );
    expect(response).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    expect(h.remoteCalls.filter((call) => call.request.action === "cancel")).toEqual([]);
  });

  it("reads a peer at most twice for a burst of its events, and no other peer", async () => {
    const h = harness();
    h.connected.add("peer-a");
    h.connected.add("peer-b");
    h.notices.syncPeers();
    await settle();
    const before = h.remoteCalls.length;
    for (let i = 0; i < 40; i++) {
      h.owners.get("peer-a")!.unread.push(item(`burst-${i}`));
      h.notices.onRemoteEvent(updated("peer-a"));
    }
    await settle();

    const reads = h.remoteCalls.slice(before);
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(reads.every((call) => call.peer === "peer-a")).toBe(true);
    expect((await snapshotOf(h.notices, undefined)).unread).toHaveLength(40);
  });

  it("never brings back or re-announces a notice dismissed while a read was out", async () => {
    const owner = new FakeOwner();
    owner.unread.push(item("seen"));
    let hold: (() => void) | undefined;
    let held = false;
    const notified: string[] = [];
    const notices = new FederatedAgentNotifications({
      local: async () => ({ ok: true, snapshot: { unread: [], scheduled: [], earlier: [] } }),
      remote: async (_target, request) => {
        // A read takes a snapshot when it starts and answers later.
        const answer = request.action === "snapshot" ? { ok: true as const, snapshot: owner.snapshot() } : owner.manage(request);
        if (held && request.action === "snapshot") await new Promise<void>((resolve) => { hold = resolve; });
        return answer;
      },
      peers: () => [{ target: target("peer-a"), label: "Label peer-a" }],
      watch: () => undefined,
      nativeNotificationsEnabled: () => true,
      notifyNative: ({ key }) => { notified.push(key); },
      clearNative: () => undefined,
      showThread: () => undefined,
      changed: () => undefined,
    });
    notices.syncPeers();
    await settle();
    owner.unread.push(item("new"));
    held = true;
    notices.onRemoteEvent(updated("peer-a"));
    await settle();
    expect(hold).toBeDefined();

    // The operator dismisses the new notice while that read is out.
    held = false;
    await notices.manage({ action: "dismiss", id: "new", federationTarget: target("peer-a") }, undefined);
    hold!();
    await settle();

    expect((await snapshotOf(notices, undefined)).unread.map(keyOf)).toEqual(["peer-a:seen"]);
    expect(notified).toEqual([]);
  });

  it("keeps a peer's last notices through a failed read", async () => {
    const h = harness();
    h.owners.get("peer-a")!.unread.push(item("kept"));
    h.connected.add("peer-a");
    h.notices.syncPeers();
    await settle();
    // The read fails, as in an outage before the disconnect is noticed.
    h.connected.delete("peer-a");
    h.notices.onRemoteEvent(updated("peer-a"));
    await settle();

    expect((await snapshotOf(h.notices, target("peer-a"))).unread.map(keyOf)).toEqual(["peer-a:kept"]);
  });
});
