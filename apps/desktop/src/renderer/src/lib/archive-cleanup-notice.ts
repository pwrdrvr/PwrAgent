import type { ArchiveThreadCleanupResult } from "@pwragent/shared";

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
