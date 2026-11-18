import type {
  CausalMessagingContext,
  FederationCapability,
  FederationRemoteTarget,
  FederationTarget,
  ManageThreadDependenciesRequest,
  ManageThreadDependenciesResponse,
  ThreadDependency,
} from "@pwragent/shared";
import {
  THREAD_DEPENDENCIES_FEDERATION_CAPABILITY,
  THREAD_DEPENDENCY_PROVENANCE_FEDERATION_CAPABILITY,
} from "@pwragent/shared";

/** What a viewer hears when a contact's create would reach an owner that drops the contact. */
export const THREAD_DEPENDENCY_PROVENANCE_UNSUPPORTED_MESSAGE =
  "Update PwrAgent on the owning instance to register a wait there from a messaging contact's turn.";

/** What a viewer hears when the owning instance cannot manage Continue After for it. */
export const THREAD_DEPENDENCIES_UNSUPPORTED_MESSAGE =
  "Update PwrAgent on the owning instance to use Continue After on its threads from here.";

/** The federation runtime calls Continue After makes across machines. */
export type ThreadDependenciesFederationRuntime = {
  connectedPeerTargets(): Array<{ target: FederationRemoteTarget; capabilities: FederationCapability[] }>;
  remoteTargetSupportsCapability(target: FederationRemoteTarget, capability: FederationCapability): boolean;
  remoteBackend(target: FederationRemoteTarget): {
    manageThreadDependencies?(request: ManageThreadDependenciesRequest & { provenance?: CausalMessagingContext }): Promise<ManageThreadDependenciesResponse>;
  };
};

const FIELDS = [
  "action", "backend", "threadId", "conditions", "mode", "onFailure", "continuation", "deliver", "handoff",
  "steps", "holdMerge", "dependencyId", "dependencyIds", "conditionIndex", "note", "pullRequest", "repeat",
] as const;

/**
 * The messaging contact a peer's create carries. It can only narrow the
 * wait: without it the owner would run the wait as the peer. A source must
 * name its messaging owner, which authorizes the contact's tool calls; a
 * malformed one is ambiguous, never dropped.
 */
export function readFederationThreadDependencyProvenance(value: unknown): CausalMessagingContext {
  const provenance = value && typeof value === "object" ? (value as { provenance?: unknown }).provenance : undefined;
  if (provenance === undefined) return {};
  const { causalMessagingSource: source, causalMessagingAmbiguous: ambiguous } = provenance && typeof provenance === "object"
    ? provenance as Record<string, unknown> : {};
  if (ambiguous === undefined && source === undefined) return {};
  if (ambiguous !== undefined || !source || typeof source !== "object") return { causalMessagingAmbiguous: true };
  const { ownerId, requestId, surfaceSelector, instanceId } = source as Record<string, unknown>;
  if (typeof ownerId !== "string" || typeof requestId !== "string" || typeof instanceId !== "string" || !instanceId
    || (surfaceSelector !== undefined && typeof surfaceSelector !== "string")) return { causalMessagingAmbiguous: true };
  return { causalMessagingSource: { ownerId, requestId, instanceId, ...(surfaceSelector !== undefined ? { surfaceSelector } : {}) } };
}

/**
 * The owner's copy of a peer's request. Only the named fields cross; the
 * federation target never does. The owner validates the rest as it would a
 * local request.
 */
export function readFederationThreadDependenciesRequest(value: unknown): ManageThreadDependenciesRequest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const request = value as Record<string, unknown>;
  if (!["create", "list", "cancel", "dismiss", "active", "mark_done"].includes(request.action as string)) return undefined;
  const owned: Record<string, unknown> = {};
  for (const field of FIELDS) if (request[field] !== undefined) owned[field] = request[field];
  return owned as ManageThreadDependenciesRequest;
}

function supports(runtime: ThreadDependenciesFederationRuntime, target: FederationRemoteTarget): boolean {
  return runtime.remoteTargetSupportsCapability(target, THREAD_DEPENDENCIES_FEDERATION_CAPABILITY)
    && runtime.remoteTargetSupportsCapability(target, "turn_control");
}

/**
 * Sends a request about a peer's thread to that peer. An owner without the
 * capability, or one that does not grant turn control, gets no request.
 */
export async function manageRemoteThreadDependencies(
  request: ManageThreadDependenciesRequest,
  target: FederationRemoteTarget,
  viewerInstanceId: string | undefined,
  runtime: ThreadDependenciesFederationRuntime,
  provenance: CausalMessagingContext = {},
): Promise<ManageThreadDependenciesResponse> {
  const remote = runtime.remoteBackend(target);
  if (!supports(runtime, target) || !remote.manageThreadDependencies) throw new Error(THREAD_DEPENDENCIES_UNSUPPORTED_MESSAGE);
  const owned = readFederationThreadDependenciesRequest(request);
  if (!owned) throw new Error("Unknown Continue After action.");
  // Only a create stores its requester; an older owner would drop the
  // contact and run the wait as this peer.
  const causal = owned.action === "create" && Boolean(provenance.causalMessagingSource || provenance.causalMessagingAmbiguous);
  if (causal && !runtime.remoteTargetSupportsCapability(target, THREAD_DEPENDENCY_PROVENANCE_FEDERATION_CAPABILITY)) {
    throw new Error(THREAD_DEPENDENCY_PROVENANCE_UNSUPPORTED_MESSAGE);
  }
  return qualifyPeerDependentOwners(
    await remote.manageThreadDependencies(causal ? { ...owned, provenance } : owned), target, viewerInstanceId);
}

/**
 * The owner relays the waits its own peers keep on its thread, named from
 * the owner. From the viewer, the owner's peer is that peer, unless it is
 * the viewer itself.
 */
export function qualifyPeerDependentOwners(
  response: ManageThreadDependenciesResponse,
  owner: FederationRemoteTarget,
  viewerInstanceId: string | undefined,
): ManageThreadDependenciesResponse {
  if (!response.peerDependents?.length) return response;
  return {
    ...response,
    peerDependents: response.peerDependents.map((entry) => ({
      ...entry,
      owner: entry.owner.scope === "remote"
        ? entry.owner.instanceId === viewerInstanceId ? { scope: "local" } satisfies FederationTarget : entry.owner
        : owner,
    })),
  };
}

/** How long one peer may take to list its waits before it is left out. */
export const PEER_ACTIVE_TIMEOUT_MS = 3_000;
/** Share a burst of window reads without retaining a peer's snapshot for long. */
export const PEER_ACTIVE_CACHE_MS = 1_000;

function withinPeerTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The peer did not list its waits in time.")), PEER_ACTIVE_TIMEOUT_MS);
  });
  return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
}

/** One runtime's peer snapshots, including requests still within their timeout. */
export function createPeerActiveDependencyCollector(
  runtime: ThreadDependenciesFederationRuntime,
  now: () => number = Date.now,
) {
  const entries = new Map<string, { promise: Promise<ThreadDependency[]>; expiresAt?: number }>();
  return {
    invalidate(instanceId?: string): void {
      if (instanceId === undefined) entries.clear();
      else entries.delete(instanceId);
    },
    async collect(): Promise<Array<{ dependency: ThreadDependency; owner: FederationRemoteTarget }>> {
      // Recheck connectivity and grants even when a snapshot is cached.
      const peers = runtime.connectedPeerTargets().filter((peer) => supports(runtime, peer.target));
      const connected = new Set(peers.map((peer) => peer.target.instanceId));
      for (const instanceId of entries.keys()) if (!connected.has(instanceId)) entries.delete(instanceId);
      const results = await Promise.allSettled(peers.map(async ({ target }) => {
        let entry = entries.get(target.instanceId);
        if (!entry || (entry.expiresAt !== undefined && now() >= entry.expiresAt)) {
          // Cache the promise before starting the RPC so all callers share
          // slow peers too. A failed peer is briefly cached as absent.
          const next: NonNullable<typeof entry> = {
            promise: Promise.resolve().then(async () => {
              const remote = runtime.remoteBackend(target);
              const response = remote.manageThreadDependencies
                ? await withinPeerTimeout(remote.manageThreadDependencies({ action: "active" }))
                : { dependencies: [] };
              return response.dependencies;
            }).catch(() => []).then((dependencies) => {
              // An invalidation detaches this entry. Its late reply cannot
              // put an older snapshot back into the cache.
              next.expiresAt = now() + PEER_ACTIVE_CACHE_MS;
              return dependencies;
            }),
          };
          entries.set(target.instanceId, next);
          entry = next;
        }
        return (await entry.promise).map((dependency) => ({ dependency, owner: target }));
      }));
      return results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    },
  };
}

const peerActiveCollectors = new WeakMap<ThreadDependenciesFederationRuntime, ReturnType<typeof createPeerActiveDependencyCollector>>();

/** Drop a changed owner's snapshot before windows react to its event. */
export function invalidatePeerActiveDependencies(runtime: ThreadDependenciesFederationRuntime, instanceId?: string): void {
  peerActiveCollectors.get(runtime)?.invalidate(instanceId);
}

/**
 * Every capable peer's active registrations, named by owner. Window `active`
 * and per-thread `list` reads share the same short-lived snapshots. A peer
 * that fails or times out is left out, so it cannot hold up local chips.
 */
export async function collectPeerActiveDependencies(
  runtime: ThreadDependenciesFederationRuntime,
): Promise<Array<{ dependency: ThreadDependency; owner: FederationRemoteTarget }>> {
  let collector = peerActiveCollectors.get(runtime);
  if (!collector) {
    collector = createPeerActiveDependencyCollector(runtime);
    peerActiveCollectors.set(runtime, collector);
  }
  return await collector.collect();
}

/** Adds the waits other machines keep on this machine's thread. */
export async function appendPeerDependents(
  response: ManageThreadDependenciesResponse,
  thread: { backend: string; threadId: string },
  localInstanceId: string | undefined,
  runtime: ThreadDependenciesFederationRuntime,
): Promise<ManageThreadDependenciesResponse> {
  if (!localInstanceId) return response;
  const peerDependents = [
    ...response.peerDependents ?? [],
    ...(await collectPeerActiveDependencies(runtime)).filter(({ dependency }) => dependency.conditions.some((condition) =>
      condition.target?.instanceId === localInstanceId && condition.backend === thread.backend && condition.threadId === thread.threadId)),
  ];
  return peerDependents.length ? { ...response, peerDependents } : response;
}
