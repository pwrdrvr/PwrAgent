import {
  PwrAgentFederatedThreadMessageError,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type {
  PwrAgentFederatedThreadMessageHandler,
  PwrAgentFederatedThreadMessageResult,
} from "../agent-tools/pwragent-thread-orchestration-agent-tools";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import {
  FederatedThreadTargetError,
  resolveFederatedThreadTarget,
  type ResolvedFederatedThreadTarget,
} from "./federated-thread-target-service";
import {
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

export function createFederatedThreadMessageHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadMessageHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    const activeRuntime = runtime();
    let match: ResolvedFederatedThreadTarget | undefined;
    try {
      match = await resolveFederatedThreadTarget({
        runtime: activeRuntime,
        targetStore: options.targetStore,
        request,
      });
    } catch (error) {
      if (error instanceof FederatedThreadTargetError) {
        const message = error.message.endsWith(".")
          ? error.message.slice(0, -1)
          : error.message;
        throw new PwrAgentFederatedThreadMessageError(
          error.code,
          `${message}; the message was not sent.`,
        );
      }
      throw error;
    }
    return match ? await sendToRemoteThread(match, request) : undefined;
  };
}

async function sendToRemoteThread(
  match: ResolvedFederatedThreadTarget,
  request: Parameters<PwrAgentFederatedThreadMessageHandler>[0],
): Promise<PwrAgentFederatedThreadMessageResult> {
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
}
