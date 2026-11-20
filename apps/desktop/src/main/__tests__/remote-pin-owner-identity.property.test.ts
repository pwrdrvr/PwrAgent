import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import {
  type NavigationSnapshot,
  type NavigationThreadSummary,
  type RemoteThreadPin,
} from "@pwragent/shared/contracts/navigation";
import { RemoteThreadSummaryCache, type RemoteThreadSummaryPeer } from "../federation/remote-thread-summary-cache";
import { loadViewerNavigationPins } from "../app-server/navigation-viewer-pins";

const owners = ["peer-one", "peer-two", "peer-three", "peer-four"] as const;
const target = (instanceId: string): FederationRemoteTarget => ({ scope: "remote", instanceId });
const peer = (instanceId: string): RemoteThreadSummaryPeer => ({ target: target(instanceId), label: instanceId,
  capabilities: ["thread_navigation", "navigation_group_invalidations"] });
const ref = (owner: string, backend: NavigationThreadSummary["source"], threadId: string) =>
  buildFederatedThreadRef({ instanceId: owner, backend, threadId });
function row(owner: string, backend: NavigationThreadSummary["source"], id: string): NavigationThreadSummary {
  return { id, source: backend, title: `Owner ${owner} ${backend} ${id}`, titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, pinnedRank: "owner-rank",
    federation: { ref: ref(owner, backend, id), instanceLabel: owner, peerStatus: "connected" } };
}
const pin = (summary: NavigationThreadSummary, index: number): RemoteThreadPin => ({
  ref: summary.federation!.ref, summary, addedAt: 0, instanceLabel: summary.federation!.instanceLabel, localPinnedRank: String(index + 1),
});
const snapshot = (threads: NavigationThreadSummary[]): NavigationSnapshot => ({ backend: "all", unchanged: false,
  fetchedAt: 0, threads, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } });
// The oracle uses owner/backend/id tuples, independently of production key helpers.
const identity = (thread: NavigationThreadSummary) => JSON.stringify([
  thread.federation?.ref.target.scope === "remote" ? thread.federation.ref.target.instanceId : undefined, thread.source, thread.id,
]);
async function settle() { for (let i = 0; i < 120; i++) await Promise.resolve(); }

it.each([false, true])("retains disconnected direct pins sharing backend and thread ID (saved summary: %s)", async (saved) => {
  const fetchSnapshot = vi.fn(async (): Promise<NavigationSnapshot> => { throw new Error("Disconnected peers must not be fetched"); });
  const cache = new RemoteThreadSummaryCache({ peers: () => [], fetchSnapshot,
    fetchArchivedThreads: async () => [], peerStatus: () => ({ status: "disconnected" }) });
  const originals = [pin(row("peer-one", "codex", "same"), 0), pin(row("peer-two", "codex", "same"), 1)];
  const pins = saved ? originals : originals.map(({ summary: _summary, ...pin }) => pin);
  try {
    const result = await cache.resolvePinnedThreads(pins);
    expect(result.threads.map(identity)).toEqual(originals.map((pin) => identity(pin.summary!)));
    expect(result.threads.every((thread) => thread.federation?.peerStatus === "disconnected")).toBe(true);
    expect(result.archived).toEqual([]); expect(result.refreshed).toEqual([]);
    expect(fetchSnapshot).not.toHaveBeenCalled();
  } finally { cache.dispose(); }
});

it("matches the owner population across direct pins, colliding relays and directly pinned derived children", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    backend: fc.constantFrom("codex", "claude"), childBackend: fc.constantFrom("codex", "claude"),
    childId: fc.constantFrom("same", "child"), directThird: fc.boolean(), directFourth: fc.boolean(),
    reversePins: fc.boolean(), reverseRows: fc.boolean(), connected: fc.boolean(),
  }), async (operation) => {
    const [first, second, third, fourth] = owners;
    const parents = [row(first, operation.backend, "same"), row(second, operation.backend, "same")];
    const children = [third, fourth].map((owner) => ({ ...row(owner, operation.childBackend, operation.childId),
      parentThreadId: "same", parentThreadBackend: operation.backend, parentThreadInstanceId: first,
    }));
    const directRows = [...parents, ...(operation.directThird ? [children[0]!] : []), ...(operation.directFourth ? [children[1]!] : [])];
    const pins = directRows.map(pin);
    if (operation.reversePins) pins.reverse();
    const relays = children.map((child) => ({ ...child, title: `Relayed ${child.title}` }));
    const firstRows = [parents[0]!, ...relays];
    if (operation.reverseRows) firstRows.reverse();
    const ownerPopulation = new Map<string, NavigationThreadSummary[]>(owners.map((owner) => [owner, owner === first ? firstRows
      : owner === second ? [parents[1]!] : [children[owner === third ? 0 : 1]!]]));
    const fetch = vi.fn(async (owner: FederationRemoteTarget) => snapshot(ownerPopulation.get(owner.instanceId)!));
    const onPeerInterestChanged = vi.fn();
    const fetchArchivedThreads = vi.fn(async () => []);
    const cache = new RemoteThreadSummaryCache({ peers: () => operation.connected ? owners.map(peer) : [],
      fetchSnapshot: async () => { throw new Error("Use bounded owner reads"); }, fetchPinnedSnapshot: fetch,
      fetchArchivedThreads, peerStatus: () => ({ status: operation.connected ? "connected" : "disconnected" }), hasNavigationSubscription: () => true, onPeerInterestChanged,
    });
    try {
      await cache.resolvePinnedThreads(pins); await settle();
      const result = await cache.resolvePinnedThreads(pins);
      const expected = new Map(directRows.map((thread) => [identity(thread), { thread, derived: false }]));
      if (operation.connected) {
        for (const relay of relays) if (!expected.has(identity(relay))) expected.set(identity(relay), { thread: relay, derived: true });
      }
      expect(result.threads.map(identity).sort()).toEqual([...expected.keys()].sort());
      for (const thread of result.threads) {
        const wanted = expected.get(identity(thread))!;
        expect(thread.title).toBe(wanted.thread.title);
        expect(Boolean(thread.federation?.derivedFromMountedParent)).toBe(wanted.derived);
        expect(thread.pinnedRank).toBe("owner-rank");
      }
      expect(result.refreshed.map(({ summary }) => identity(summary)).sort()).toEqual(operation.connected ? directRows.map(identity).sort() : []);
      expect(result.refreshed.every(({ ref, summary }) => ref.target.scope === "remote"
        && summary.federation?.ref.target.scope === "remote" && ref.target.instanceId === summary.federation.ref.target.instanceId)).toBe(true);
      expect(result.archived).toEqual([]); expect(fetchArchivedThreads).not.toHaveBeenCalled();
      const saved = pins.map((pin) => ({ ...pin.summary!, pinnedRank: pin.localPinnedRank }));
      const viewerRows = await loadViewerNavigationPins({ readRemoteThreadPinNavigationRows: async () => saved,
        updateRemoteThreadPinSnapshots: async () => false, removeRemoteThreadPin: async () => false }, cache);
      const viewerRanks = new Map(saved.map((thread) => [identity(thread), thread.pinnedRank]));
      expect(viewerRows.map(identity).sort()).toEqual([...expected.keys()].sort());
      for (const thread of viewerRows) expect(thread.pinnedRank).toBe(viewerRanks.get(identity(thread)));
      // Repeated resolution and viewer rank projection do not add owner reads.
      expect(fetch).toHaveBeenCalledTimes(operation.connected ? directRows.length : 0);
      const interests = onPeerInterestChanged.mock.calls.at(-1)?.[0] as Array<{ instanceId: string; threadSelection: unknown }>;
      expect(interests.map((interest) => interest.instanceId).sort()).toEqual(pins.map((pin) => (pin.ref.target as FederationRemoteTarget).instanceId).sort());
      for (const interest of interests) expect(interest.threadSelection).toEqual(!operation.connected ? { kind: "all" } : { kind: "threads", threads: interest.instanceId === first
        ? [...new Map([parents[0]!, ...children].map((thread) => [JSON.stringify([thread.source, thread.id]), { backend: thread.source, threadId: thread.id }])).values()]
          .sort((a, b) => `${a.backend}:${a.threadId}`.localeCompare(`${b.backend}:${b.threadId}`))
        : [{ backend: interest.instanceId === second ? operation.backend : operation.childBackend,
          threadId: interest.instanceId === second ? "same" : operation.childId }] });
    } finally { cache.dispose(); }
  }), { numRuns: 25, examples: [[{ backend: "codex", childBackend: "codex", childId: "same", directThird: false,
    directFourth: true, reversePins: false, reverseRows: false, connected: true }]] });
});

it.each(["archived", "unknown", "failed"])("requires the native owner's archive proof with a colliding relay (%s)", async (archiveState) => {
  const parent = row("peer-one", "codex", "parent");
  const archived = row("peer-one", "codex", "same");
  const child = { ...row("peer-two", "codex", "same"), parentThreadId: parent.id,
    parentThreadBackend: "codex" as const, parentThreadInstanceId: "peer-one" };
  const pins = [pin(parent, 0), pin(archived, 1), pin(child, 2)];
  const fetchArchivedThreads = vi.fn(async (owner: FederationRemoteTarget) => {
    if (archiveState === "failed") throw new Error("Archive lookup failed");
    return archiveState === "archived" && owner.instanceId === "peer-one" ? [archived] : [];
  });
  const cache = new RemoteThreadSummaryCache({ peers: () => owners.slice(0, 2).map(peer),
    fetchSnapshot: async () => { throw new Error("Use bounded owner reads"); },
    fetchPinnedSnapshot: async (owner) => snapshot(owner.instanceId === "peer-one" ? [parent, child] : [child]),
    fetchArchivedThreads, peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
  });
  try {
    await cache.resolvePinnedThreads(pins); await settle();
    const result = await cache.resolvePinnedThreads(pins);
    expect(result.threads.map(identity)).toEqual(archiveState === "archived"
      ? [identity(parent), identity(child)] : [identity(parent), identity(archived), identity(child)]);
    expect(result.archived).toEqual(archiveState === "archived" ? [pins[1]!.ref] : []);
    expect(result.refreshed.map(({ summary }) => identity(summary))).toEqual([identity(parent), identity(child)]);
    expect(fetchArchivedThreads).toHaveBeenCalledTimes(1);
    expect(fetchArchivedThreads).toHaveBeenCalledWith(target("peer-one"), "codex", ["same"], { deadlineAt: expect.any(Number) });
  } finally { cache.dispose(); }
});
