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
    // Same refusal the local path makes, read off the peer's own listing:
    // archiving mid-turn leaves the provider running work nothing shows.
    if (request.archive && match.thread.threadStatus === "active") {
      throw new PwrAgentFederatedThreadInspectionError(
        "forbidden",
        `Thread ${request.backend}:${request.threadId} on ${match.peer.label} has a turn running. Stop it with stop_thread before archiving it.`,
      );
    }
    if (request.archive && !request.dryRun) {
      await match.backend.archiveThread({
        backend: request.backend,
        threadId: request.threadId,
      });
    }
    // First, as locally: the peer checks the destination on its own disk,
    // and a refused move should not leave the other changes half applied.
    if (request.projectPath !== undefined && !request.dryRun) {
      await match.backend.handoffThreadWorkspace({
        backend: request.backend,
        threadId: request.threadId,
        direction: "to-project",
        targetPath: request.projectPath,
      });
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
