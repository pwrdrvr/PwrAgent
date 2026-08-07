import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  FederationCapability,
  FederationInstanceId,
  FederationRemoteTarget,
  ThreadIdentifier,
} from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";
import { getMainLogger } from "../log";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import type { DesktopFederationRuntime } from "./federation-runtime";

export type FederatedThreadTargetRequest = {
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
  instanceId?: FederationInstanceId;
  resolutionMode?: "remembered_only" | "discover_only";
};

export type ResolvedFederatedThreadTarget = {
  backend: FederationBackendOperations;
  peer: {
    target: FederationRemoteTarget;
    label: string;
    capabilities: FederationCapability[];
  };
  thread: AppServerThreadSummary;
};

export class FederatedThreadTargetError extends Error {
  constructor(
    readonly code: "peer_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "FederatedThreadTargetError";
  }
}

const log = getMainLogger("pwragent:federated-thread-target");

export async function resolveFederatedThreadTarget(params: {
  runtime: DesktopFederationRuntime;
  targetStore?: RemoteThreadTargetStore;
  request: FederatedThreadTargetRequest;
}): Promise<ResolvedFederatedThreadTarget | undefined> {
  const { request, runtime, targetStore } = params;
  const connectedPeers = runtime.connectedPeerTargets();
  const rememberedTargets = request.instanceId
    || request.resolutionMode === "discover_only"
    ? []
    : await readRememberedTargets(targetStore, request);
  if (rememberedTargets.length > 1) {
    throw new Error(
      `Thread ${request.threadId} has multiple remembered federation owners: ${rememberedTargets
        .map((target) => target.instanceLabel)
        .join(", ")}. Pass instanceId to select the intended target.`,
    );
  }
  const targetInstanceId = request.instanceId ?? rememberedTargets[0]?.instanceId;
  if (targetInstanceId) {
    const peer = connectedPeers.find(
      (candidate) => candidate.target.instanceId === targetInstanceId,
    );
    if (!peer) {
      const health = await runtime.health();
      const knownPeer = health.peers.find(
        (candidate) => candidate.id === targetInstanceId,
      );
      const instanceLabel = knownPeer
        ? formatFederationPeerDisplayLabel(knownPeer, health.peers)
        : rememberedTargets[0]?.instanceLabel ?? targetInstanceId;
      const status = knownPeer?.status ?? "not enrolled";
      throw new FederatedThreadTargetError(
        "peer_unavailable",
        `Federation instance ${instanceLabel}, the known owner of thread ${request.threadId}, is ${status}.`,
      );
    }
    if (!peer.capabilities.includes("thread_navigation")) {
      throw new Error(
        `Federation instance ${peer.label} owns thread ${request.threadId} but does not grant thread_navigation.`,
      );
    }
    const match = await resolveThreadOnPeer(runtime, peer, request);
    if (!match) {
      if (
        rememberedTargets.length > 0
        && request.resolutionMode === "remembered_only"
      ) {
        throw new Error(
          `Thread ${request.threadId} was not found on its remembered federation owner ${peer.label}.`,
        );
      }
      return undefined;
    }
    await rememberTarget(targetStore, match, request);
    return match;
  }

  if (request.resolutionMode === "remembered_only") {
    return undefined;
  }

  const peers = connectedPeers.filter((peer) =>
    peer.capabilities.includes("thread_navigation"),
  );
  const failures: Array<{ label: string; message: string }> = [];
  const matches = (
    await Promise.all(
      peers.map(async (peer): Promise<ResolvedFederatedThreadTarget | undefined> => {
        try {
          return await resolveThreadOnPeer(runtime, peer, request);
        } catch (error) {
          failures.push({
            label: peer.label,
            message: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      }),
    )
  ).filter((match): match is ResolvedFederatedThreadTarget => Boolean(match));

  if (matches.length > 1) {
    throw new Error(
      `Thread ${request.threadId} was reported by multiple federation instances: ${matches
        .map((match) => match.peer.label)
        .join(", ")}.`,
    );
  }
  const match = matches[0];
  if (!match) {
    if (failures.length > 0) {
      throw new Error(
        `Could not resolve thread ${request.threadId} because federation lookup failed on ${failures
          .map((failure) => `${failure.label}: ${failure.message}`)
          .join("; ")}.`,
      );
    }
    return undefined;
  }
  await rememberTarget(targetStore, match, request);
  return match;
}

async function resolveThreadOnPeer(
  runtime: DesktopFederationRuntime,
  peer: ResolvedFederatedThreadTarget["peer"],
  request: FederatedThreadTargetRequest,
): Promise<ResolvedFederatedThreadTarget | undefined> {
  const backend = runtime.remoteBackend(peer.target);
  let thread: AppServerThreadSummary | undefined;
  try {
    thread = (
      await backend.resolveThread({
        backend: request.backend,
        threadId: request.threadId,
      })
    ).thread;
  } catch {
    // Mixed-version peers may predate backend.resolveThread. Their unfiltered
    // list still provides an exact-ID compatibility path.
    thread = (
      await backend.listThreads({ backend: request.backend })
    ).threads.find((candidate) => candidate.id === request.threadId);
  }
  return thread ? { backend, peer, thread } : undefined;
}

async function readRememberedTargets(
  targetStore: RemoteThreadTargetStore | undefined,
  request: FederatedThreadTargetRequest,
) {
  if (!targetStore) {
    return [];
  }
  try {
    return await targetStore.listRemoteThreadTargets({
      backend: request.backend,
      threadId: request.threadId,
    });
  } catch (error) {
    log.warn("failed to read remote thread target", {
      backend: request.backend,
      error: error instanceof Error ? error.message : String(error),
      threadId: request.threadId,
    });
    return [];
  }
}

async function rememberTarget(
  targetStore: RemoteThreadTargetStore | undefined,
  match: ResolvedFederatedThreadTarget,
  request: FederatedThreadTargetRequest,
): Promise<void> {
  if (!targetStore) {
    return;
  }
  try {
    await targetStore.rememberRemoteThreadTarget({
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
      backend: request.backend,
      threadId: request.threadId,
    });
  } catch (error) {
    log.warn("failed to remember remote thread target", {
      backend: request.backend,
      error: error instanceof Error ? error.message : String(error),
      instanceId: match.peer.target.instanceId,
      threadId: request.threadId,
    });
  }
}
