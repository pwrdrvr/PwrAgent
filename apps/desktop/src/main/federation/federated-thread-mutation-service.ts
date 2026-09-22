import {
  threadSeenWatermark,
  type FederationCapability,
} from "@pwragent/shared";
import {
  PwrAgentFederatedThreadInspectionError,
  type PwrAgentFederatedThreadMutationHandler,
  type PwrAgentFederatedThreadMutationRequest,
} from "../agent-tools/pwragent-thread-agent-tools";
import type { RemoteThreadTargetStore } from "../state/remote-thread-target-store";
import {
  FederatedThreadTargetError,
  resolveFederatedThreadTarget,
  type ResolvedFederatedThreadTarget,
} from "./federated-thread-target-service";
import { hasFederationErrorCode } from "./federation-rpc";
import {
  getDesktopFederationRuntime,
  type DesktopFederationRuntime,
} from "./federation-runtime";

/**
 * The grant each change needs on the owning peer: the same capability the
 * peer checks on the backend method the change calls. Pin and read state
 * are browse-level navigation calls, and asking for turn control to mark a
 * thread read would refuse a peer that allows exactly that.
 */
function capabilitiesForMutation(
  request: PwrAgentFederatedThreadMutationRequest,
): FederationCapability[] {
  const required: FederationCapability[] = [];
  if (
    request.title !== undefined
    || request.modelSettings !== undefined
    || request.executionMode !== undefined
    || request.projectPath !== undefined
    || request.archive !== undefined
  ) {
    required.push("turn_control");
  }
  if (request.pinned !== undefined || request.unread !== undefined) {
    required.push("thread_navigation");
  }
  return required;
}

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
    for (const capability of capabilitiesForMutation(request)) {
      if (!match.peer.capabilities.includes(capability)) {
        throw new Error(
          `Federation instance ${match.peer.label} owns thread ${request.threadId} but does not grant ${capability}.`,
        );
      }
    }
    // The same refusals the local path makes, read off the peer's own
    // listing, and made before anything changes.
    const threadLabel =
      `Thread ${request.backend}:${request.threadId} on ${match.peer.label}`;
    if (request.archive === true && match.thread.archivedAt !== undefined) {
      throw new PwrAgentFederatedThreadInspectionError(
        "invalid_arguments",
        `${threadLabel} is already archived.`,
      );
    }
    if (request.archive === false && match.thread.archivedAt === undefined) {
      throw new PwrAgentFederatedThreadInspectionError(
        "invalid_arguments",
        `${threadLabel} is not archived.`,
      );
    }
    // Archiving mid-turn leaves the provider running work nothing shows.
    if (request.archive === true && match.thread.threadStatus === "active") {
      throw new PwrAgentFederatedThreadInspectionError(
        "forbidden",
        `${threadLabel} has a turn running. Stop it with stop_thread before archiving it.`,
      );
    }
    if (request.unread === true && match.thread.updatedAt === undefined) {
      throw new PwrAgentFederatedThreadInspectionError(
        "invalid_arguments",
        `${threadLabel} has no update time to mark unread against.`,
      );
    }
    // A pin sent as `pinned` rather than a rank needs the owner to append it
    // after its own order, which only the current navigation protocol does.
    if (request.pinned !== undefined) {
      runtime().assertRemoteNavigationQueryProtocol(match.peer.target);
    }
    if (request.archive === true && !request.dryRun) {
      await match.backend.archiveThread({
        backend: request.backend,
        threadId: request.threadId,
      });
    }
    if (request.archive === false && !request.dryRun) {
      try {
        await match.backend.restoreThread({
          backend: request.backend,
          threadId: request.threadId,
        });
      } catch (error) {
        if (!hasFederationErrorCode(error, "method_not_found")) throw error;
        throw new PwrAgentFederatedThreadInspectionError(
          "invalid_arguments",
          `${match.peer.label} runs a PwrAgent too old to restore a thread for another instance. Restore it from Settings → Archived Threads on that instance.`,
        );
      }
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
      if (request.pinned !== undefined) {
        await match.backend.setThreadPin({
          backend: request.backend,
          threadId: request.threadId,
          pinned: request.pinned,
        });
      }
      if (request.unread !== undefined) {
        await match.backend.markThreadSeen({
          backend: request.backend,
          threadId: request.threadId,
          ...threadSeenWatermark(match.thread.updatedAt, request.unread),
        });
      }
    }
    return {
      instanceId: match.peer.target.instanceId,
      instanceLabel: match.peer.label,
    };
  };
}
