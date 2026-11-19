import type { RestoreThreadResponse } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../notifications/AppNoticeToast";

type Detached = NonNullable<NonNullable<NonNullable<RestoreThreadResponse["worktrees"]>[number]["snapshot"]>["detachedFrom"]>;

function why(detached: Detached): string {
  switch (detached.reason) {
    case "in-use": return `${detached.branch} is checked out in another worktree`;
    case "moved": return `${detached.branch} has moved since the thread was archived`;
    case "missing": return `${detached.branch} no longer exists`;
  }
}

/**
 * One notice per restored worktree that came back on a detached HEAD instead
 * of its branch. It stays until dismissed: commits made there move no
 * branch, which is easy to miss once the thread looks normal again.
 */
export function detachedRestoreNotices(
  responses: readonly RestoreThreadResponse[],
  threadTitle?: string,
): AppNoticeToastNotice[] {
  return responses.flatMap((response) => (response.worktrees ?? []).flatMap((worktree) => {
    const detached = worktree.restored ? worktree.snapshot?.detachedFrom : undefined;
    if (!detached) return [];
    return [{
      id: `restore-detached:${response.backend}:${response.threadId}:${worktree.worktreePath}`,
      title: "Worktree restored on a detached HEAD",
      message: `${why(detached)}, so ${threadTitle ? `“${threadTitle}”` : "the thread"} came back at the same commit on a detached HEAD, with its saved changes. Commits made there won't move ${detached.branch}.`,
      autoDismiss: false,
      facts: [
        { label: "Worktree", value: worktree.worktreePath },
        { label: "Commit", value: detached.head.slice(0, 12) },
        ...(detached.checkedOutAt ? [{ label: `${detached.branch} is in`, value: detached.checkedOutAt }] : []),
      ],
    }];
  }));
}
