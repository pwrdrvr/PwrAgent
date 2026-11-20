import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { FederationCapability, FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import type { ThreadDependency } from "@pwragent/shared/contracts/thread-dependencies";
import {
  PEER_ACTIVE_TIMEOUT_MS, THREAD_DEPENDENCIES_UNSUPPORTED_MESSAGE, appendPeerDependents, collectPeerActiveDependencies,
  manageRemoteThreadDependencies, qualifyPeerDependentOwners, readFederationThreadDependenciesRequest,
  readFederationThreadDependencyProvenance, THREAD_DEPENDENCY_PROVENANCE_UNSUPPORTED_MESSAGE,
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
  // A peer's create carries the contact whose turn asked for it. Without
  // one the owner runs the wait as the peer, so the contact can only narrow
  // it. A contact the owner cannot attribute to its messaging owner must
  // narrow it all the way, never disappear.
  it("reads a peer's contact fail-closed: absent, well-formed with its messaging owner, or ambiguous", () => {
    // Shaped like a source, with each field valid, empty, mistyped or absent.
    const field = fc.oneof(fc.string({ minLength: 1 }), fc.constant(""), fc.integer(), fc.constant(null), fc.constant(undefined));
    const sourceLike = fc.record({ ownerId: field, requestId: field, surfaceSelector: field, instanceId: field }, { requiredKeys: [] });
    const provenanceArb = fc.oneof(fc.anything(), fc.record({
      causalMessagingSource: fc.oneof(sourceLike, fc.anything()),
      causalMessagingAmbiguous: fc.oneof(fc.constant(undefined), fc.constant(true), fc.anything()),
    }, { requiredKeys: [] }));
    fc.assert(fc.property(provenanceArb, (provenance) => {
      const read = readFederationThreadDependencyProvenance({ action: "create", provenance });
      const fields = provenance && typeof provenance === "object"
        ? provenance as { causalMessagingSource?: unknown; causalMessagingAmbiguous?: unknown } : {};
      if (fields.causalMessagingSource === undefined && fields.causalMessagingAmbiguous === undefined) {
        expect(read).toEqual({});
      } else if (read.causalMessagingSource) {
        expect(fields.causalMessagingAmbiguous).toBeUndefined();
        // The owner keeps the source's own fields as sent, and nothing else.
        const sent = fields.causalMessagingSource as Record<string, unknown>;
        expect(read.causalMessagingSource).toEqual(Object.fromEntries(["ownerId", "requestId", "surfaceSelector", "instanceId"]
          .filter((key) => sent[key] !== undefined).map((key) => [key, sent[key]])));
        expect(read.causalMessagingSource.instanceId).toEqual(expect.stringMatching(/./));
        expect(typeof read.causalMessagingSource.ownerId).toBe("string");
        expect(typeof read.causalMessagingSource.requestId).toBe("string");
      } else {
        expect(read).toEqual({ causalMessagingAmbiguous: true });
      }
    }));
    const source = { ownerId: "profile", requestId: "request", surfaceSelector: "telegram:alice", instanceId: "mac" };
    expect(readFederationThreadDependencyProvenance({ provenance: { causalMessagingSource: source } }))
      .toEqual({ causalMessagingSource: source });
    // A source that names no messaging owner would read as this owner's own contact.
    for (const instanceId of [undefined, ""]) {
      expect(readFederationThreadDependencyProvenance({ provenance: { causalMessagingSource: { ...source, instanceId } } }))
        .toEqual({ causalMessagingAmbiguous: true });
    }
    expect(readFederationThreadDependencyProvenance({ action: "create" })).toEqual({});
  });

  it("sends a contact's create only to an owner that keeps the contact", async () => {
    const source = { ownerId: "profile", requestId: "request", instanceId: "mac" };
    const create = { action: "create" as const, backend: "codex" as const, threadId: "waiting", continuation: "Go on." };
    const older = runtime([{ target: lab, capabilities: ["thread_dependencies_v1", "turn_control"],
      answer: async () => ({ dependencies: [] }) }]);
    for (const provenance of [{ causalMessagingSource: source }, { causalMessagingAmbiguous: true }]) {
      await expect(manageRemoteThreadDependencies(create, lab, "mac", older.value, provenance))
        .rejects.toThrow(THREAD_DEPENDENCY_PROVENANCE_UNSUPPORTED_MESSAGE);
    }
    expect(older.calls).toEqual([]);
    // The operator's own create, and every other action, still reach it.
    await manageRemoteThreadDependencies(create, lab, "mac", older.value, {});
    await manageRemoteThreadDependencies({ action: "list", backend: "codex", threadId: "waiting" }, lab, "mac", older.value,
      { causalMessagingSource: source });
    expect(older.calls.map((call) => call.request)).toEqual([create, { action: "list", backend: "codex", threadId: "waiting" }]);

    const current = runtime([{ target: lab,
      capabilities: ["thread_dependencies_v1", "thread_dependency_provenance_v1", "turn_control"],
      answer: async () => ({ dependencies: [] }) }]);
    await manageRemoteThreadDependencies(create, lab, "mac", current.value, { causalMessagingSource: source });
    expect(current.calls).toEqual([{ instanceId: "lab", request: { ...create, provenance: { causalMessagingSource: source } } }]);
    expect(readFederationThreadDependencyProvenance(current.calls[0]!.request)).toEqual({ causalMessagingSource: source });
  });

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
