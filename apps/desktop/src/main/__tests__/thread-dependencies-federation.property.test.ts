import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { FederationRemoteTarget, ThreadDependency } from "@pwragent/shared";
import {
  PEER_ACTIVE_CACHE_MS, appendPeerDependents, collectPeerActiveDependencies, createPeerActiveDependencyCollector,
  invalidatePeerActiveDependencies,
  type ThreadDependenciesFederationRuntime,
} from "../app-server/thread-dependencies-federation";

function fixture() {
  const peers = ["lab", "win"].map((instanceId) => ({
    target: { scope: "remote", instanceId } satisfies FederationRemoteTarget,
    capabilities: ["thread_dependencies_v1", "turn_control"] as const,
  }));
  const calls: string[] = [];
  const connected = new Set(peers.map(({ target }) => target.instanceId));
  const permitted = new Set(connected);
  const owned = new Map(peers.map(({ target }) => [target.instanceId, [{
    id: `${target.instanceId}-wait`, backend: "codex", threadId: "consumer", status: "waiting",
    mode: "all", onFailure: "wait", createdAt: 1, updatedAt: 1, evidence: [],
    conditions: [{ backend: "codex", threadId: "prereq", when: "marked_done", target: { scope: "remote", instanceId: "mac" } }],
  } satisfies ThreadDependency]]));
  const runtime: ThreadDependenciesFederationRuntime = {
    connectedPeerTargets: () => peers.filter(({ target }) => connected.has(target.instanceId))
      .map((peer) => ({ ...peer, capabilities: [...peer.capabilities] })),
    remoteTargetSupportsCapability: (target) => permitted.has(target.instanceId),
    remoteBackend: (target) => ({
      manageThreadDependencies: async () => {
        calls.push(target.instanceId);
        return { dependencies: owned.get(target.instanceId)! };
      },
    }),
  };
  return { runtime, peers, calls, owned, connected, permitted };
}

describe("Continue After peer request budget", () => {
  it("shares one owner snapshot across any mix of sidebar and per-thread reads in a burst", async () => {
    // The owners are the data oracle. Adding cards must not add peer requests.
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({ active: fc.boolean(), threadId: fc.constantFrom("prereq", "unrelated", "another") }), { minLength: 2, maxLength: 20 }),
      async (reads) => {
        const { runtime, peers, calls, owned } = fixture();
        for (const { active, threadId } of reads) {
          const entries = active
            ? await collectPeerActiveDependencies(runtime)
            : (await appendPeerDependents({ dependencies: [] }, { backend: "codex", threadId }, "mac", runtime)).peerDependents ?? [];
          const expected = peers.flatMap(({ target }) => owned.get(target.instanceId)!
            .filter((dependency) => active || dependency.conditions.some((condition) => condition.threadId === threadId))
            .map((dependency) => ({ dependency, owner: target })));
          expect(entries).toEqual(expected);
        }
        expect(calls).toEqual(peers.map(({ target }) => target.instanceId));
      },
    ), { numRuns: 25 });
  });

  it("makes two peer requests for two consecutive thread lists", async () => {
    const { runtime, calls } = fixture();
    await appendPeerDependents({ dependencies: [] }, { backend: "codex", threadId: "prereq" }, "mac", runtime);
    await appendPeerDependents({ dependencies: [] }, { backend: "codex", threadId: "unrelated" }, "mac", runtime);
    expect(calls).toEqual(["lab", "win"]);
  });

  it("keeps owner freshness and request budgets across changes, expiry and permission transitions", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        action: fc.constantFrom("read", "change", "expire", "disconnect", "reconnect", "revoke", "grant"),
        peer: fc.integer({ min: 0, max: 1 }),
      }), { minLength: 1, maxLength: 40 }),
      async (operations) => {
        const { runtime, peers, calls, owned, connected, permitted } = fixture();
        let now = 0;
        const collector = createPeerActiveDependencyCollector(runtime, () => now);
        const snapshots = new Map<string, { dependencies: ThreadDependency[]; until: number }>();
        let expectedRequests = 0;
        for (const { action, peer } of operations) {
          const instanceId = peers[peer]!.target.instanceId;
          if (action === "change") {
            owned.set(instanceId, owned.get(instanceId)!.map((dependency) => ({ ...dependency, updatedAt: dependency.updatedAt + 1 })));
            collector.invalidate(instanceId);
            snapshots.delete(instanceId);
          } else if (action === "expire") now += PEER_ACTIVE_CACHE_MS;
          else if (action === "disconnect") connected.delete(instanceId);
          else if (action === "reconnect") connected.add(instanceId);
          else if (action === "revoke") permitted.delete(instanceId);
          else if (action === "grant") permitted.add(instanceId);

          const expected = peers.flatMap(({ target }) => {
            const id = target.instanceId;
            if (!connected.has(id) || !permitted.has(id)) {
              snapshots.delete(id);
              return [];
            }
            let snapshot = snapshots.get(id);
            if (!snapshot || now >= snapshot.until) {
              snapshot = { dependencies: owned.get(id)!, until: now + PEER_ACTIVE_CACHE_MS };
              snapshots.set(id, snapshot);
              expectedRequests++;
            }
            return snapshot.dependencies.map((dependency) => ({ dependency, owner: target }));
          });
          expect(await collector.collect()).toEqual(expected);
          expect(calls).toHaveLength(expectedRequests);
        }
      },
    ), { numRuns: 25 });
  });

  it("coalesces concurrent callers even after a pending read outlives the cache TTL", async () => {
    const { runtime, calls, owned } = fixture();
    let now = 0;
    let resolve!: (response: { dependencies: ThreadDependency[] }) => void;
    const pending = new Promise<{ dependencies: ThreadDependency[] }>((done) => { resolve = done; });
    runtime.remoteBackend = (target) => ({
      manageThreadDependencies: () => { calls.push(target.instanceId); return pending; },
    });
    const collector = createPeerActiveDependencyCollector(runtime, () => now);
    const first = collector.collect();
    await Promise.resolve();
    now += PEER_ACTIVE_CACHE_MS * 2;
    const rest = Array.from({ length: 10 }, () => collector.collect());
    resolve({ dependencies: owned.get("lab")! });
    const results = await Promise.all([first, ...rest]);
    expect(results.every((result) => JSON.stringify(result) === JSON.stringify(results[0]))).toBe(true);
    expect(calls).toEqual(["lab", "win"]);
    await collector.collect();
    expect(calls).toEqual(["lab", "win"]);
  });

  it("does not let an invalidated in-flight response overwrite the newer owner snapshot", async () => {
    const { runtime, owned } = fixture();
    const original = runtime.remoteBackend;
    let resolve!: (response: { dependencies: ThreadDependency[] }) => void;
    const pending = new Promise<{ dependencies: ThreadDependency[] }>((done) => { resolve = done; });
    let first = true;
    runtime.remoteBackend = (target) => first && target.instanceId === "lab"
      ? { manageThreadDependencies: () => { first = false; return pending; } }
      : original(target);
    const old = collectPeerActiveDependencies(runtime);
    await Promise.resolve();
    invalidatePeerActiveDependencies(runtime, "lab");
    const current = await collectPeerActiveDependencies(runtime);
    resolve({ dependencies: [] });
    await old;
    expect(await collectPeerActiveDependencies(runtime)).toEqual(current);
    expect(current.find(({ owner }) => owner.instanceId === "lab")?.dependency).toEqual(owned.get("lab")![0]);
  });

  it("shares failures briefly and retries them when the snapshot expires", async () => {
    const { runtime, calls } = fixture();
    let now = 0;
    runtime.remoteBackend = (target) => ({
      manageThreadDependencies: async () => { calls.push(target.instanceId); throw new Error("offline"); },
    });
    const collector = createPeerActiveDependencyCollector(runtime, () => now);
    expect(await collector.collect()).toEqual([]);
    expect(await collector.collect()).toEqual([]);
    expect(calls).toEqual(["lab", "win"]);
    now += PEER_ACTIVE_CACHE_MS;
    expect(await collector.collect()).toEqual([]);
    expect(calls).toEqual(["lab", "win", "lab", "win"]);
  });
});
