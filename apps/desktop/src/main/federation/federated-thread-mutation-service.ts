import {
  PwrAgentFederatedThreadInspectionError,
  type PwrAgentFederatedThreadMutationHandler,
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

export function createFederatedThreadMutationHandler(
  options: {
    runtime?: () => DesktopFederationRuntime;
    targetStore?: RemoteThreadTargetStore;
  } = {},
): PwrAgentFederatedThreadMutationHandler {
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
    if (!match.peer.capabilities.includes("turn_control")) {
      throw new Error(
        `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant turn_control.`,
      );
    }
    if (!request.dryRun) {
      if (request.title !== undefined) {
        await match.backend.renameThread({
          backend: request.backend,
          threadId: request.threadId,
          name: request.title,
        });
      }
      if (request.modelSettings) {
        await match.backend.setThreadModelSettings({
          backend: request.backend,
          threadId: request.threadId,
          ...request.modelSettings,
        });
      }
      if (request.executionMode !== undefined) {
        await match.backend.setThreadExecutionMode({
          backend: request.backend,
          threadId: request.threadId,
          executionMode: request.executionMode,
        });
      }
    }
    return {
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
    };
  };
}
