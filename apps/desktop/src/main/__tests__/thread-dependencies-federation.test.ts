import { describe, expect, it, vi } from "vitest";
import type { FederationCapability, FederationRemoteTarget, ThreadDependency } from "@pwragent/shared";
import {
  PEER_ACTIVE_TIMEOUT_MS, THREAD_DEPENDENCIES_UNSUPPORTED_MESSAGE, appendPeerDependents, collectPeerActiveDependencies,
  manageRemoteThreadDependencies, qualifyPeerDependentOwners, readFederationThreadDependenciesRequest,
  type ThreadDependenciesFederationRuntime,
} from "../app-server/thread-dependencies-federation";

const lab: FederationRemoteTarget = { scope: "remote", instanceId: "lab" };
const win: FederationRemoteTarget = { scope: "remote", instanceId: "win" };

function wait(id: string, conditionTarget: string, threadId = "prereq"): ThreadDependency {
  return {
    id, backend: "codex", threadId: "waiting", status: "waiting", mode: "all", onFailure: "notify", deliver: "operator",
    createdAt: 1, updatedAt: 1, evidence: [],
    conditions: [{ backend: "codex", threadId, when: "marked_done", target: { scope: "remote", instanceId: conditionTarget } }],
  };
}

function runtime(peers: Array<{ target: FederationRemoteTarget; capabilities: FederationCapability[]; answer: () => Promise<{ dependencies: ThreadDependency[] }> }>) {
  const calls: Array<{ instanceId: string; request: unknown }> = [];
  const value: ThreadDependenciesFederationRuntime = {
    connectedPeerTargets: () => peers.map(({ target, capabilities }) => ({ target, capabilities })),
    remoteTargetSupportsCapability: (target, capability) => peers.find((peer) => peer.target.instanceId === target.instanceId)?.capabilities.includes(capability) ?? false,
    remoteBackend: (target) => ({
      manageThreadDependencies: vi.fn(async (request) => {
        calls.push({ instanceId: target.instanceId, request });
        return await peers.find((peer) => peer.target.instanceId === target.instanceId)!.answer();
      }),
    }),
  };
  return { value, calls };
}

describe("Continue After across machines", () => {
  it("never forwards the viewer's federation target or unknown fields to the owner", () => {
    expect(readFederationThreadDependenciesRequest({
      action: "mark_done", backend: "codex", threadId: "waiting", dependencyId: "d", note: "done",
      federationTarget: lab, injected: true,
    })).toEqual({ action: "mark_done", backend: "codex", threadId: "waiting", dependencyId: "d", note: "done" });
    expect(readFederationThreadDependenciesRequest({ action: "drop_table" })).toBeUndefined();
  });

  it("forwards a merge card's PR, so the owner answers its merge holds", () => {
    expect(readFederationThreadDependenciesRequest({
      action: "list", backend: "codex", threadId: "merging", pullRequest: "https://github.com/acme/app/pull/17",
    })).toEqual({ action: "list", backend: "codex", threadId: "merging", pullRequest: "https://github.com/acme/app/pull/17" });
  });

  it("sends nothing to an owner without the capability or turn control", async () => {
    const { value, calls } = runtime([{ target: lab, capabilities: ["turn_control"], answer: async () => ({ dependencies: [] }) }]);
    await expect(manageRemoteThreadDependencies({ action: "list", backend: "codex", threadId: "waiting" }, lab, "mac", value))
      .rejects.toThrow(THREAD_DEPENDENCIES_UNSUPPORTED_MESSAGE);
    expect(calls).toEqual([]);
  });

  it("lists only the waits peers keep on this machine's thread, skipping peers that do not answer", async () => {
    const { value } = runtime([
      { target: lab, capabilities: ["thread_dependencies_v1", "turn_control"], answer: async () => ({
        dependencies: [wait("on-us", "mac"), wait("on-someone-else", "win"), wait("other-thread", "mac", "unrelated")],
      }) },
      { target: win, capabilities: ["thread_dependencies_v1", "turn_control"], answer: async () => { throw new Error("offline"); } },
    ]);
    const response = await appendPeerDependents({ dependencies: [] }, { backend: "codex", threadId: "prereq" }, "mac", value);
    expect(response.peerDependents?.map((entry) => [entry.dependency.id, entry.owner])).toEqual([["on-us", lab]]);
  });

  it("leaves out a peer that does not answer in time instead of holding up the rest", async () => {
    vi.useFakeTimers();
    try {
      const { value } = runtime([
        { target: lab, capabilities: ["thread_dependencies_v1", "turn_control"], answer: async () => ({ dependencies: [wait("lab-wait", "mac")] }) },
        { target: win, capabilities: ["thread_dependencies_v1", "turn_control"], answer: () => new Promise(() => {}) },
      ]);
      const listed = collectPeerActiveDependencies(value);
      await vi.advanceTimersByTimeAsync(PEER_ACTIVE_TIMEOUT_MS);
      expect((await listed).map((entry) => entry.dependency.id)).toEqual(["lab-wait"]);
    } finally { vi.useRealTimers(); }
  });

  it("shows a viewer its own waits on a peer's thread, relayed by the owner", async () => {
    // The viewer "mac" opens the owner "win"'s thread. The owner relays every
    // machine's waits on it, the viewer's included.
    const { value } = runtime([{ target: { scope: "remote", instanceId: "mac" }, capabilities: ["thread_dependencies_v1", "turn_control"],
      answer: async () => ({ dependencies: [wait("mac-wait", "win")] }) }]);
    const owned = await appendPeerDependents({ dependencies: [] }, { backend: "codex", threadId: "prereq" }, "win", value);
    const seen = qualifyPeerDependentOwners(owned, win, "mac");
    expect(seen.peerDependents?.map((entry) => [entry.dependency.id, entry.owner])).toEqual([["mac-wait", { scope: "local" }]]);
  });
});
