import type {
  AppServerThreadSummary,
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";
import {
  PwrAgentFederatedThreadMessageError,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type {
  PwrAgentFederatedThreadMessageHandler,
  PwrAgentFederatedThreadMessageResult,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import { getMainLogger } from "../log";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import {
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

type ResolvedRemoteThread = {
  backend: FederationBackendOperations;
  peer: {
    target: FederationRemoteTarget;
    label: string;
    capabilities: FederationCapability[];
  };
  thread: AppServerThreadSummary;
};

const log = getMainLogger("pwragent:federated-thread-message");

export function createFederatedThreadMessageHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadMessageHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    const activeRuntime = runtime();
    const connectedPeers = activeRuntime.connectedPeerTargets();
    const rememberedTargets = request.instanceId
      ? []
      : await readRememberedTargets(options.targetStore, request);
    if (rememberedTargets.length > 1) {
      throw new Error(
        `Thread ${request.threadId} has multiple remembered federation owners: ${rememberedTargets
          .map((target) => target.instanceLabel)
          .join(", ")}. Pass instanceId to select the intended target.`,
      );
    }
    const targetInstanceId =
      request.instanceId ?? rememberedTargets[0]?.instanceId;
    if (targetInstanceId) {
      const peer = connectedPeers.find(
        (candidate) => candidate.target.instanceId === targetInstanceId,
      );
      if (!peer) {
        const health = await activeRuntime.health();
        const knownPeer = health.peers.find(
          (candidate) => candidate.id === targetInstanceId,
        );
        const instanceLabel = knownPeer
          ? formatFederationPeerDisplayLabel(knownPeer, health.peers)
          : rememberedTargets[0]?.instanceLabel ?? targetInstanceId;
        const status = knownPeer?.status ?? "not enrolled";
        throw new PwrAgentFederatedThreadMessageError(
          "peer_unavailable",
          `Federation instance ${instanceLabel}, the known owner of thread ${request.threadId}, is ${status}; the message was not sent.`,
        );
      }
      if (!peer.capabilities.includes("thread_navigation")) {
        throw new Error(
          `Federation instance ${peer.label} owns thread ${request.threadId} but does not grant thread_navigation.`,
        );
      }
      const match = await resolveThreadOnPeer(activeRuntime, peer, request);
      if (!match) {
        return undefined;
      }
      return await sendToRemoteThread(match, request, options.targetStore);
    }

    const peers = connectedPeers.filter((peer) =>
      peer.capabilities.includes("thread_navigation"),
    );
    const failures: Array<{ label: string; message: string }> = [];
    const matches = (
      await Promise.all(
        peers.map(async (peer): Promise<ResolvedRemoteThread | undefined> => {
          try {
            return await resolveThreadOnPeer(activeRuntime, peer, request);
          } catch (error) {
            failures.push({
              label: peer.label,
              message: error instanceof Error ? error.message : String(error),
            });
            return undefined;
          }
        }),
      )
    ).filter((match): match is ResolvedRemoteThread => Boolean(match));

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
    return await sendToRemoteThread(match, request, options.targetStore);
  };
}

async function resolveThreadOnPeer(
  runtime: DesktopFederationRuntime,
  peer: ResolvedRemoteThread["peer"],
  request: Parameters<PwrAgentFederatedThreadMessageHandler>[0],
): Promise<ResolvedRemoteThread | undefined> {
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

async function sendToRemoteThread(
  match: ResolvedRemoteThread,
  request: Parameters<PwrAgentFederatedThreadMessageHandler>[0],
  targetStore: RemoteThreadTargetStore | undefined,
): Promise<PwrAgentFederatedThreadMessageResult> {
  if (!match.peer.capabilities.includes("turn_control")) {
    throw new Error(
      `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant turn_control.`,
    );
  }
  // Ownership was confirmed even if turn admission subsequently fails (busy,
  // policy, or backend error), so retain the route before attempting the send.
  await rememberTarget(targetStore, {
    instanceId: match.peer.target.instanceId,
    instanceLabel: match.peer.label,
    backend: request.backend,
    threadId: request.threadId,
  });
  const turn = await match.backend.startTurn({
    backend: request.backend,
    threadId: request.threadId,
    input: request.input,
    messageOrigin: request.messageOrigin,
    executionMode: request.executionMode,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    serviceTier: request.serviceTier,
    fastMode: request.fastMode,
    approvalPolicy: request.approvalPolicy,
    sandbox: request.sandbox,
  });
  return {
    backend: turn.backend,
    threadId: turn.threadId,
    turnId: turn.turnId,
    title: match.thread.title,
    instanceId: match.peer.target.instanceId,
    instanceLabel: match.peer.label,
  } satisfies PwrAgentFederatedThreadMessageResult;
}

async function readRememberedTargets(
  targetStore: RemoteThreadTargetStore | undefined,
  request: Parameters<PwrAgentFederatedThreadMessageHandler>[0],
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
  target: Parameters<RemoteThreadTargetStore["rememberRemoteThreadTarget"]>[0],
): Promise<void> {
  if (!targetStore) {
    return;
  }
  try {
    await targetStore.rememberRemoteThreadTarget(target);
  } catch (error) {
    log.warn("failed to remember remote thread target", {
      backend: target.backend,
      error: error instanceof Error ? error.message : String(error),
      instanceId: target.instanceId,
      threadId: target.threadId,
    });
  }
}
