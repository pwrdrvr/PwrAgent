import type { ArchiveCleanupProgress, ArchiveThreadCleanupResult } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../features/notifications/AppNoticeToast";

export function formatArchiveCleanupProgress(progress: ArchiveCleanupProgress): AppNoticeToastNotice | undefined {
  if (progress.active.length === 0 && progress.queued === 0) return undefined;
  return {
    id: `archive-cleanup:${progress.batchId}`,
    title: "Cleaning up archived worktrees",
    message: `${progress.completed} of ${progress.total} completed · ${progress.active.length} active · ${progress.queued} waiting`,
    autoDismiss: false,
    status: { label: "In progress", state: "progress" },
    facts: progress.active.flatMap((job) => job.worktreePath ? [{ label: "Worktree", value: job.worktreePath }] : []),
  };
}

export type ArchiveThreadNotice = {
  id: string;
  title: string;
  message: string;
  detail?: string;
};

export function formatArchiveCleanupNotice(
  cleanup: ArchiveThreadCleanupResult[]
): ArchiveThreadNotice | undefined {
  const failures = cleanup.filter(
    (item) => (item.error || (!item.skippedReason?.startsWith("Worktree is still used by")
      && item.skippedReason !== "Worktree directory no longer exists."))
      && (!item.removedWorktree || item.error || item.skippedReason)
  );
  const firstFailure = failures[0];
  if (!firstFailure) {
    return undefined;
  }

  const reason = firstFailure.error ?? firstFailure.skippedReason ?? "cleanup was skipped";
  const title = "Worktree cleanup skipped";
  const message = "Thread archived. The worktree cleanup did not complete.";
  const detail = firstFailure.worktreePath
    ? `${firstFailure.worktreePath}: ${reason}`
    : reason;

  return {
    id: [firstFailure.worktreePath ?? "no-worktree", reason, Date.now().toString()].join("\n"),
    title,
    message,
    detail,
  };
}
