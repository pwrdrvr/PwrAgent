import {
  PwrAgentFederatedThreadInspectionError,
  type PwrAgentFederatedThreadInspectionHandler,
} from "../agent-tools/pwragent-thread-agent-tools";
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

export function createFederatedThreadInspectionHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadInspectionHandler {
  const runtime = options.runtime ?? getDesktopFederationRuntime;
  return async (request) => {
    let match: ResolvedFederatedThreadTarget | undefined;
    try {
      match = await resolveFederatedThreadTarget({
        runtime: runtime(),
        targetStore: options.targetStore,
        request,
      });
    } catch (error) {
      if (error instanceof FederatedThreadTargetError) {
        throw new PwrAgentFederatedThreadInspectionError(
          error.code,
          error.message,
        );
      }
      throw error;
    }
    if (!match) {
      return undefined;
    }
    if (!match.peer.capabilities.includes("thread_detail")) {
      throw new Error(
        `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant thread_detail.`,
      );
    }
    const read = await match.backend.readThread({
      backend: request.backend,
      threadId: request.threadId,
      includeTurns: request.includeTurns,
      ...(request.before ? { before: request.before } : {}),
      limit: request.limit,
      viewOnly: true,
    });
    return {
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
      thread: match.thread,
      read,
    };
  };
}
