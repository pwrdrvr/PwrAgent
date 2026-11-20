import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import { type NavigationSnapshot, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";

const owners = ["peer-one", "peer-two", "peer-three", "peer-four"] as const;
const backends = ["codex", "claude"] as const;
const ids = ["same", "other"] as const;
const target = (instanceId: string): FederationRemoteTarget => ({ scope: "remote", instanceId });
const peer = (instanceId: string) => ({
  target: target(instanceId), label: instanceId, capabilities: ["thread_navigation" as const],
});
function row(owner: string, source: NavigationThreadSummary["source"], id: string, title: string): NavigationThreadSummary {
  return {
    source, id, title, titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false },
    federation: {
      ref: buildFederatedThreadRef({ instanceId: owner, backend: source, threadId: id }),
      instanceLabel: owner, peerStatus: "connected",
    },
  };
}
function legacyRow(thread: NavigationThreadSummary): NavigationThreadSummary {
  const { federation: _federation, ...unstamped } = thread;
  return unstamped;
}
const snapshot = (threads: NavigationThreadSummary[]): NavigationSnapshot => ({
  backend: "all", unchanged: false, fetchedAt: 0, threads, directories: [], inboxThreadKeys: [],
  launchpadDefaults: { backend: "codex", executionMode: "default" },
});
const lookup = (owner: string, backend: NavigationThreadSummary["source"] = "codex", threadId = "same") => ({
  target: target(owner), backend, threadId,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it("does not let colliding relayed children rename their serving peer or their native owners", () => {
  const fetchSnapshot = vi.fn(async () => snapshot([]));
  const cache = new RemoteThreadSummaryCache({ peers: () => owners.map(peer), fetchSnapshot,
    fetchArchivedThreads: async () => [], peerStatus: () => ({ status: "connected" }) });
  try {
    cache.rememberThreadNames("peer-three", [row("peer-three", "codex", "same", "Owner three current")],
      cache.reserveThreadNameObservation());
    cache.rememberThreadNames("peer-one", [
      row("peer-one", "codex", "same", "Owner one native"),
      row("peer-three", "codex", "same", "Relayed owner three stale"),
      row("peer-four", "codex", "same", "Relayed owner four"),
    ], cache.reserveThreadNameObservation());
    expect(cache.cachedThreadNameFromPeer(lookup("peer-one"))?.title).toBe("Owner one native");
    expect(cache.cachedThreadNameFromPeer(lookup("peer-three"))?.title).toBe("Owner three current");
    expect(cache.cachedThreadNameFromPeer(lookup("peer-four"))).toBeUndefined();
    expect(fetchSnapshot).not.toHaveBeenCalled();
  } finally { cache.dispose(); }
});

it.each([false, true])("never answers an exact native lookup with a relay (native present: %s)", async (present) => {
  const native = row("peer-one", "codex", "same", "Owner one native");
  const fetchSnapshot = vi.fn(async () => snapshot([
    row("peer-three", "codex", "same", "Relayed owner three"),
    row("peer-four", "codex", "same", "Relayed owner four"),
    ...(present ? [native] : []),
  ]));
  const cache = new RemoteThreadSummaryCache({ peers: () => owners.map(peer), fetchSnapshot,
    fetchArchivedThreads: async () => [], peerStatus: () => ({ status: "connected" }) });
  try {
    expect(await cache.threadFromPeer(lookup("peer-one"))).toEqual(present ? native : undefined);
    expect(fetchSnapshot).toHaveBeenCalledExactlyOnceWith(target("peer-one"), {
      kind: "threads", threads: [{ backend: "codex", threadId: "same" }],
    });
  } finally { cache.dispose(); }
});

// The oracle is the native owner's response, prepared before any relays are
// added. No production identity helper or snapshot filtering defines the answer.
it("matches the owner oracle for exact rows and names across shuffled mixed-owner snapshots", async () => {
  const population = owners.flatMap((owner) => [
    row(owner, "codex", "same", `Owner ${owner} codex same`),
    row(owner, "claude", "same", `Owner ${owner} claude same`),
    row(owner, "codex", "other", `Owner ${owner} codex other`),
  ]);
  await fc.assert(fc.asyncProperty(fc.record({
    order: fc.shuffledSubarray(population.map((_, index) => index), { minLength: 12, maxLength: 12 }),
    absentOwner: fc.option(fc.constantFrom(...owners), { nil: undefined }),
    legacy: fc.boolean(),
  }), async ({ order, absentOwner, legacy }) => {
    const nativeByOwner = new Map(owners.map((owner, index) => [owner,
      owner === absentOwner ? [] : population.slice(index * 3, index * 3 + 3).map((thread) => legacy ? legacyRow(thread) : thread),
    ]));
    const fetchSnapshot = vi.fn(async (queried: FederationRemoteTarget) => snapshot(order.flatMap((index) => {
      const thread = population[index]!;
      const owner = owners[Math.floor(index / 3)]!;
      if (owner === queried.instanceId) return nativeByOwner.get(owner)!.filter((native) => native.source === thread.source && native.id === thread.id);
      return [{ ...thread, title: `Stale relay of ${thread.title}` }];
    })));
    const fetchArchivedThreads = vi.fn(async () => []);
    let connected = true;
    let now = 0;
    const cache = new RemoteThreadSummaryCache({ peers: () => connected ? owners.map(peer) : [],
      fetchSnapshot, fetchArchivedThreads, now: () => now, peerStatus: () => ({ status: connected ? "connected" : "disconnected" }) });
    try {
      await cache.searchForJump({ query: "Owner" });
      for (const owner of owners) {
        for (const backend of backends) for (const threadId of ids) {
          const expected = nativeByOwner.get(owner)!.find((thread) => thread.source === backend && thread.id === threadId);
          expect(await cache.threadFromPeer(lookup(owner, backend, threadId))).toEqual(expected);
          expect(cache.cachedThreadNameFromPeer(lookup(owner, backend, threadId))?.title).toBe(expected?.title);
        }
      }
      // Complete cached snapshots cover all exact reads; names remain local
      // reads even after invalidation, TTL lapse and peer disconnection.
      now = 60_000;
      cache.invalidate();
      connected = false;
      for (const owner of owners) for (const thread of nativeByOwner.get(owner)!) {
        expect(cache.cachedThreadNameFromPeer(lookup(owner, thread.source, thread.id))?.title).toBe(thread.title);
      }
      expect(await cache.threadFromPeer(lookup("peer-one"))).toBeUndefined();
      expect(fetchSnapshot).toHaveBeenCalledTimes(owners.length);
      expect(fetchArchivedThreads).not.toHaveBeenCalled();
    } finally { cache.dispose(); }
  }), { numRuns: 25 });
});

const operationArb = fc.record({
  owner: fc.constantFrom(...owners), backend: fc.constantFrom(...backends), threadId: fc.constantFrom(...ids),
  relayOnly: fc.boolean(), legacy: fc.boolean(),
});
const observationsArb = fc.array(operationArb, { minLength: 2, maxLength: 12, size: "max" }).chain((operations) => fc.record({
  operations: fc.constant(operations),
  delivery: fc.shuffledSubarray(operations.map((_, index) => index), { minLength: operations.length, maxLength: operations.length }),
  rowOrder: fc.shuffledSubarray([...owners], { minLength: owners.length, maxLength: owners.length }),
}));

it("only advances names from owner observations in reserved request order, regardless of delivery or row order", () => {
  fc.assert(fc.property(observationsArb, ({ operations, delivery, rowOrder }) => {
    const fetchSnapshot = vi.fn(async () => snapshot([]));
    const onPeerInterestChanged = vi.fn();
    const cache = new RemoteThreadSummaryCache({ peers: () => owners.map(peer), fetchSnapshot,
      fetchArchivedThreads: async () => [], peerStatus: () => ({ status: "connected" }), onPeerInterestChanged });
    try {
      const requests = operations.map((operation, index) => {
        const native = operation.relayOnly ? undefined
          : row(operation.owner, operation.backend, operation.threadId, `Owner observation ${index}`);
        return {
          ...operation, native, sequence: cache.reserveThreadNameObservation(),
          rows: rowOrder.flatMap((owner) => owner === operation.owner
            ? native ? [operation.legacy ? legacyRow(native) : native] : []
            : [row(owner, operation.backend, operation.threadId, `Relay observation ${index} for ${owner}`)]),
        };
      });
      const delivered = new Set<number>();
      for (const index of delivery) {
        const request = requests[index]!;
        cache.rememberThreadNames(request.owner, request.rows, request.sequence);
        delivered.add(index);
        for (const owner of owners) for (const backend of backends) for (const threadId of ids) {
          // Latest *started* native observation among the delivered requests.
          const expected = requests.filter((candidate, ordinal) => delivered.has(ordinal) && candidate.native
            && candidate.owner === owner && candidate.backend === backend && candidate.threadId === threadId).at(-1)?.native;
          expect(cache.cachedThreadNameFromPeer(lookup(owner, backend, threadId))?.title).toBe(expected?.title);
        }
      }
      expect(fetchSnapshot).not.toHaveBeenCalled();
      expect(onPeerInterestChanged).not.toHaveBeenCalled();
    } finally { cache.dispose(); }
  }));
});

it.each([false, true])("fences a late mixed-owner read after a newer observation (invalidated: %s)", async (invalidated) => {
  const oldRead = deferred<NavigationSnapshot>();
  const newRead = deferred<NavigationSnapshot>();
  const oldNative = row("peer-one", "codex", "same", "Old owner name");
  const newNative = row("peer-one", "codex", "same", "New owner name");
  const relay = row("peer-three", "codex", "same", "Relayed name");
  const fetchSnapshot = vi.fn().mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
  const cache = new RemoteThreadSummaryCache({ peers: () => owners.map(peer), fetchSnapshot,
    fetchArchivedThreads: async () => [], peerStatus: () => ({ status: "connected" }) });
  try {
    const oldLookup = cache.threadFromPeer(lookup("peer-one"));
    if (invalidated) {
      cache.invalidate("peer-one");
      const newLookup = cache.threadFromPeer(lookup("peer-one"));
      newRead.resolve(snapshot([relay, newNative]));
      expect(await newLookup).toEqual(newNative);
    } else {
      // A federation-window read starts later and publishes before this
      // cache's pending round trip completes.
      cache.rememberThreadNames("peer-one", [newNative, relay], cache.reserveThreadNameObservation());
    }
    oldRead.resolve(snapshot([relay, oldNative]));
    expect(await oldLookup).toEqual(invalidated ? newNative : oldNative);
    expect(cache.cachedThreadNameFromPeer(lookup("peer-one"))?.title).toBe(newNative.title);
    expect(cache.cachedThreadNameFromPeer(lookup("peer-three"))).toBeUndefined();
    expect(fetchSnapshot).toHaveBeenCalledTimes(invalidated ? 2 : 1);
  } finally { cache.dispose(); }
});
