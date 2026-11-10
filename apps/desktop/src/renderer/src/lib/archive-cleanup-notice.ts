import type { ArchiveCleanupProgress, ArchiveThreadCleanupResult } from "@pwragent/shared";
import type { AppNoticeToastNotice } from "../features/notifications/AppNoticeToast";
import { withThreadActionErrorContext, type ThreadActionErrorContext } from "./thread-action-error-context";

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

export type ArchiveThreadNotice = AppNoticeToastNotice;

export function formatArchiveCleanupNotice(
  cleanup: ArchiveThreadCleanupResult[],
  context: ThreadActionErrorContext = {},
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
  const facts = failures.map((failure, index) => ({
    label: failure.worktreePath ? `Worktree ${index + 1}` : `Cleanup ${index + 1}`,
    value: [failure.worktreePath, failure.error ?? failure.skippedReason ?? "cleanup was skipped"].filter(Boolean).join("\n"),
  }));

  return withThreadActionErrorContext({
    id: [firstFailure.worktreePath ?? "no-worktree", reason, Date.now().toString()].join("\n"),
    title,
    message,
    facts,
    copyText: [title, message, ...facts.map((fact) => fact.value)].join("\n"),
  }, { ...context, worktreePaths: [] });
}
