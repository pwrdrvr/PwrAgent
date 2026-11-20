import { findPrimaryThreadLinkedDirectory, mergeThreadLinkedDirectories } from "@pwragent/shared/navigation-state";
import type {
  LinkedDirectorySummary,
  AppServerThreadSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DetachDirectoryFromThreadRequest,
  DetachDirectoryFromThreadResponse,
} from "@pwragent/shared/contracts/navigation";
import type { DesktopOwnerStorage } from "../storage/desktop-overlay-store";
import type { DesktopBackendRegistry } from "./backend-registry";
import {
  dedupeLinkedDirectoriesByNormalizedIdentity,
  linkedDirectoriesHaveSameWorkspaceIdentity,
  normalizeLinkedDirectoryPathForMatch,
} from "./linked-directory-identity";

/** Apply the same provider-then-overlay merge as Linked Projects before selecting the checkout. */
export function isPrimaryDirectoryForDetach(
  directory: LinkedDirectorySummary,
  allDirectories: LinkedDirectorySummary[],
  projectKey: string | undefined,
): boolean {
  const primary = findPrimaryThreadLinkedDirectory(mergeThreadLinkedDirectories(allDirectories), projectKey);
  return primary !== undefined && linkedDirectoriesHaveSameWorkspaceIdentity(primary, directory);
}

function linkedDirectoriesMatchForDetach(
  left: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
  right: Pick<LinkedDirectorySummary, "id" | "kind" | "path" | "worktreePath">,
): boolean {
  if (left.id === right.id) {
    return true;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  return (
    normalizeLinkedDirectoryPathForMatch(left.path) ===
      normalizeLinkedDirectoryPathForMatch(right.path) &&
    normalizeLinkedDirectoryPathForMatch(left.worktreePath) ===
      normalizeLinkedDirectoryPathForMatch(right.worktreePath)
  );
}

/** Run on the thread owner so membership and path comparisons use its state. */
export async function detachOwnedThreadDirectory(
  request: DetachDirectoryFromThreadRequest,
  deps: {
    overlayStore: Pick<DesktopOwnerStorage, "getThreadOverlayState" | "removeLinkedDirectory">;
    registry: Pick<DesktopBackendRegistry, "listThreads" | "publishLocalEvent">;
  },
): Promise<DetachDirectoryFromThreadResponse> {
  const backend = request.backend ?? "codex";
  const lookup = { backend, enrichDirectories: false, callerReason: "thread-id-lookup" } as const;
  const matchesThread = (thread: AppServerThreadSummary) => thread.id === request.threadId && thread.source === backend;
  const thread = (await deps.registry.listThreads(lookup)).find(matchesThread)
    ?? (await deps.registry.listThreads({ ...lookup, archived: true, skipArchivedMetadataRefresh: true })).find(matchesThread);
  if (!thread) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "not-found",
      message: "Could not find the thread on its owning instance.",
    };
  }
  const overlay = await deps.overlayStore.getThreadOverlayState({
    backend,
    threadId: request.threadId,
  });
  const currentDirectories = overlay?.extraLinkedDirectories ?? [];
  const matched = currentDirectories.find((directory) =>
    linkedDirectoriesMatchForDetach(directory, request.directory),
  );
  if (!matched) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "primary-directory",
      message:
        "Only secondary directories attached to this thread can be detached.",
    };
  }
  const allDirectories = [
    ...thread.linkedDirectories,
    ...currentDirectories,
  ];
  if (isPrimaryDirectoryForDetach(matched, allDirectories, thread.projectKey)) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "primary-directory",
      message: "This is the thread's working directory. Move the thread to another workspace first.",
    };
  }
  if (dedupeLinkedDirectoriesByNormalizedIdentity(allDirectories).length <= 1) {
    return {
      ok: false,
      backend,
      threadId: request.threadId,
      reason: "last-directory",
      message:
        "Cannot detach the last linked directory from a thread.",
    };
  }

  const next = await deps.overlayStore.removeLinkedDirectory({
    backend,
    threadId: request.threadId,
    directory: matched,
  });

  await deps.registry.publishLocalEvent({
    backend,
    notification: {
      method: "navigation/threadDirectories/updated",
      params: { reason: "selected-thread", threadIds: [request.threadId] },
    },
  });

  return {
    ok: true,
    backend,
    threadId: request.threadId,
    directories: next.extraLinkedDirectories,
  };
}
