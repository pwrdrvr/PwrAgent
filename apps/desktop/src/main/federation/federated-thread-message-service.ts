import type {
  AppServerThreadSummary,
  FederationCapability,
  FederationRemoteTarget,
} from "@pwragent/shared";
import type {
  PwrAgentFederatedThreadMessageHandler,
  PwrAgentFederatedThreadMessageResult,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
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

export function createFederatedThreadMessageHandler(
  options: { runtime?: () => DesktopFederationRuntime } = {},
): PwrAgentFederatedThreadMessageHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    const activeRuntime = runtime();
    const peers = activeRuntime
      .connectedPeerTargets()
      .filter((peer) => peer.capabilities.includes("thread_navigation"));
    const failures: Array<{ label: string; message: string }> = [];
    const matches = (
      await Promise.all(
        peers.map(async (peer): Promise<ResolvedRemoteThread | undefined> => {
          try {
            const backend = activeRuntime.remoteBackend(peer.target);
            let thread: AppServerThreadSummary | undefined;
            try {
              thread = (
                await backend.resolveThread({
                  backend: request.backend,
                  threadId: request.threadId,
                })
              ).thread;
            } catch {
              // Mixed-version peers may predate backend.resolveThread. Their
              // unfiltered list still provides an exact-ID compatibility path.
              thread = (
                await backend.listThreads({ backend: request.backend })
              ).threads.find((candidate) => candidate.id === request.threadId);
            }
            return thread
              ? { backend, peer, thread }
              : undefined;
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
    if (!match.peer.capabilities.includes("turn_control")) {
      throw new Error(
        `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant turn_control.`,
      );
    }

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
  };
}
