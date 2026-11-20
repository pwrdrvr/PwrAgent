import type { AppServerBackendKind, RestoreThreadResponse, WorktreeSnapshotSummary } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

type Detached = NonNullable<WorktreeSnapshotSummary["detachedFrom"]>;

function why(detached: Detached): string {
  switch (detached.reason) {
    case "in-use": return `${detached.branch} is checked out in another worktree`;
    case "moved": return `${detached.branch} has moved since its changes were saved`;
    case "missing": return `${detached.branch} no longer exists`;
  }
}

/**
 * The notice for one worktree that a restore put back on a detached HEAD
 * instead of its branch. It stays until dismissed: commits made there move
 * no branch, which is easy to miss once the thread looks normal again.
 */
export function detachedRestoreNotice(params: {
  backend: AppServerBackendKind;
  threadId: string;
  worktreePath: string;
  detachedFrom: Detached;
  threadTitle?: string;
}): AppNoticeToastNotice {
  const { detachedFrom: detached } = params;
  return {
    id: `restore-detached:${params.backend}:${params.threadId}:${params.worktreePath}`,
    title: "Worktree restored on a detached HEAD",
    message: `${why(detached)}, so ${params.threadTitle ? `“${params.threadTitle}”` : "the thread"} came back at the same commit on a detached HEAD, with its saved changes. Commits made there won't move ${detached.branch}.`,
    autoDismiss: false,
    facts: [
      { label: "Worktree", value: params.worktreePath },
      { label: "Commit", value: detached.head.slice(0, 12) },
      ...(detached.checkedOutAt ? [{ label: `${detached.branch} is in`, value: detached.checkedOutAt }] : []),
    ],
  };
}

/** One notice per worktree an archived-thread restore put back detached. */
export function detachedRestoreNotices(
  responses: readonly RestoreThreadResponse[],
  threadTitle?: string,
): AppNoticeToastNotice[] {
  return responses.flatMap((response) => (response.worktrees ?? []).flatMap((worktree) => {
    const detachedFrom = worktree.restored ? worktree.snapshot?.detachedFrom : undefined;
    return detachedFrom
      ? [detachedRestoreNotice({ backend: response.backend, threadId: response.threadId, worktreePath: worktree.worktreePath, detachedFrom, threadTitle })]
      : [];
  }));
}
