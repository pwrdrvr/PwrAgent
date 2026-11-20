import { findPrimaryThreadLinkedDirectory } from "@pwragent/shared";
import type {
  AppServerBackendKind,
  DetachDirectoryFromThreadRequest,
  DetachDirectoryFromThreadResponse,
  LinkedDirectorySummary,
  AppServerThreadSummary,
} from "@pwragent/shared";
import type { DesktopOwnerStorage } from "../storage/desktop-overlay-store";
import {
  dedupeLinkedDirectoriesByNormalizedIdentity,
  normalizeLinkedDirectoryPathForMatch,
} from "./linked-directory-identity";

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
    readThread: (backend: AppServerBackendKind, threadId: string) => Promise<Pick<AppServerThreadSummary, "linkedDirectories" | "projectKey"> | undefined>;
    publishUpdate: (backend: AppServerBackendKind, threadId: string) => Promise<void>;
  },
): Promise<DetachDirectoryFromThreadResponse> {
  const backend = request.backend ?? "codex";
  const thread = await deps.readThread(backend, request.threadId);
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
    ...currentDirectories,
    ...thread.linkedDirectories,
  ];
  if (matched === findPrimaryThreadLinkedDirectory(allDirectories, thread.projectKey)) {
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

  await deps.publishUpdate(backend, request.threadId);

  return {
    ok: true,
    backend,
    threadId: request.threadId,
    directories: next.extraLinkedDirectories,
  };
}
