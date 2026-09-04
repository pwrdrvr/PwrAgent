import type {
  AppServerBackendKind,
  AppServerThreadSummary,
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";
import {
  PwrAgentFederatedThreadMessageError,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type {
  PwrAgentFederatedThreadControlHandler,
  PwrAgentFederatedThreadControlRequest,
  PwrAgentFederatedThreadControlResult,
  PwrAgentFederatedThreadMessageHandler,
  PwrAgentFederatedThreadMessageResult,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import { getMainLogger } from "../log";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import type { FederationBackendOperations } from "./federation-backend-bridge";
import { isFederationPeerUnavailableError } from "./federation-peer-unavailable-error";
import { hasFederationErrorCode } from "./federation-rpc";
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

type FederatedThreadTargetRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
  resolutionMode?: "remembered_only" | "discover_only";
};

export function createFederatedThreadMessageHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadMessageHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    try {
      const match = await resolveRemoteThread(
        runtime(),
        request,
        options.targetStore,
      );
      return match
        ? await sendToRemoteThread(match, request, options.targetStore)
        : undefined;
    } catch (error) {
      if (
        error instanceof PwrAgentFederatedThreadMessageError
        && error.code === "peer_unavailable"
      ) {
        throw new PwrAgentFederatedThreadMessageError(
          error.code,
          `${error.message.replace(/\.$/, "")}; the message was not sent.`,
        );
      }
      if (error instanceof PwrAgentFederatedThreadMessageError) {
        // Preserve the legacy send_message_to_thread error classification.
        // The new structured routing codes are specific to stop/steer control.
        throw new Error(error.message, { cause: error });
      }
      throw error;
    }
  };
}

export function createFederatedThreadControlHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadControlHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    const match = await resolveRemoteThread(
      runtime(),
      request,
      options.targetStore,
    );
    return match
      ? await controlRemoteThread(match, request, options.targetStore)
      : undefined;
  };
}

async function resolveRemoteThread(
  activeRuntime: DesktopFederationRuntime,
  request: FederatedThreadTargetRequest,
  targetStore: RemoteThreadTargetStore | undefined,
): Promise<ResolvedRemoteThread | undefined> {
  const connectedPeers = activeRuntime.connectedPeerTargets();
  const rememberedTargets = request.instanceId
    || request.resolutionMode === "discover_only"
      ? []
      : await readRememberedTargets(targetStore, request);
  if (rememberedTargets.length > 1) {
    throw new PwrAgentFederatedThreadMessageError(
      "ambiguous_owner",
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
        `Federation instance ${instanceLabel}, the known owner of thread ${request.threadId}, is ${status}.`,
      );
    }
    if (!peer.capabilities.includes("thread_navigation")) {
      throw new PwrAgentFederatedThreadMessageError(
        "unsupported_capability",
        `Federation instance ${peer.label} owns thread ${request.threadId} but does not grant thread_navigation.`,
      );
    }
    const match = await resolveThreadOnPeer(activeRuntime, peer, request);
    if (!match) {
      if (
        rememberedTargets.length > 0
        || request.instanceId
      ) {
        throw new PwrAgentFederatedThreadMessageError(
          "stale_target",
          rememberedTargets.length > 0
            ? `Thread ${request.threadId} was not found on its remembered federation owner ${peer.label}.`
            : `Thread ${request.threadId} was not found on its selected federation owner ${peer.label}.`,
        );
      }
      return undefined;
    }
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
    throw new PwrAgentFederatedThreadMessageError(
      "ambiguous_owner",
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
  return match;
}

async function resolveThreadOnPeer(
  runtime: DesktopFederationRuntime,
  peer: ResolvedRemoteThread["peer"],
  request: FederatedThreadTargetRequest,
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
  } catch (error) {
    if (!hasFederationErrorCode(error, "method_not_found")) {
      throw error;
    }
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
    ...(turn.queueStatus === "queued"
      ? {
          queueStatus: "queued" as const,
          queueEntryId: turn.queueEntryId ?? turn.turnId,
        }
      : {}),
    title: match.thread.title,
    instanceId: match.peer.target.instanceId,
    instanceLabel: match.peer.label,
  } satisfies PwrAgentFederatedThreadMessageResult;
}

async function controlRemoteThread(
  match: ResolvedRemoteThread,
  request: PwrAgentFederatedThreadControlRequest,
  targetStore: RemoteThreadTargetStore | undefined,
): Promise<PwrAgentFederatedThreadControlResult> {
  if (!match.peer.capabilities.includes("turn_control")) {
    throw new PwrAgentFederatedThreadMessageError(
      "unsupported_capability",
      `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant turn_control.`,
    );
  }
  await rememberTarget(targetStore, {
    instanceId: match.peer.target.instanceId,
    instanceLabel: match.peer.label,
    backend: request.backend,
    threadId: request.threadId,
  });

  if (!match.backend.controlActiveTurn) {
    throw new PwrAgentFederatedThreadMessageError(
      "unsupported_capability",
      `Federation instance ${match.peer.label} does not support atomic active-turn control required for remote ${request.operation}.`,
    );
  }

  try {
    const controlled = await match.backend.controlActiveTurn({
      operation: request.operation,
      backend: request.backend,
      threadId: request.threadId,
      requestId: request.requestId,
      ...(request.expectedTurnId
        ? { expectedTurnId: request.expectedTurnId }
        : {}),
      ...(request.input ? { input: request.input } : {}),
      ...(request.messageOrigin
        ? { messageOrigin: request.messageOrigin }
        : {}),
    });
    if (!controlled.ok) {
      throw new PwrAgentFederatedThreadMessageError(
        controlled.error.code,
        controlled.error.message,
      );
    }
    return {
      backend: controlled.backend,
      threadId: controlled.threadId,
      turnId: controlled.turnId,
      disposition: controlled.disposition,
      ...(controlled.idempotentReplay ? { idempotentReplay: true } : {}),
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
    };
  } catch (error) {
    if (error instanceof PwrAgentFederatedThreadMessageError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (
      isFederationPeerUnavailableError(error)
      || /federation request timed out/i.test(message)
    ) {
      throw new PwrAgentFederatedThreadMessageError(
        "peer_unavailable",
        `Federation instance ${match.peer.label} became unavailable while attempting remote ${request.operation}: ${message}`,
      );
    }
    throw new PwrAgentFederatedThreadMessageError(
      /unsupported|does not support/i.test(message)
        ? "unsupported_capability"
        : /active|expected turn|stale|in progress/i.test(message)
          ? "stale_target"
          : "internal_error",
      message,
    );
  }
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
