import { type AppServerThreadSummary } from "@pwragent/shared";
import {
  linkedDirectoryWorktreePath,
} from "./linked-directory-identity";
import {
  readNonEmptyString,
  readRecord,
} from "./backend-registry-notification-values";
import {
  type ArchivedWorktreeRepairReport,
} from "./backend-registry-types";

export class AutomaticArchiveCancelledError extends Error {}

/** A hibernation check failed again just before removal. */
export class CheckoutHibernationKeptError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** Rows per page, and pages, of admission's incremental provider read. More
 * changes than this cost about as much as one complete read, so read that. */
export const ARCHIVE_FLEET_DELTA_PAGE_SIZE = 5;
export const ARCHIVE_FLEET_DELTA_PAGES = 20;

export function archiveWorkspacePaths(thread: Pick<AppServerThreadSummary, "projectKey" | "linkedDirectories">): string[] {
  return [thread.projectKey, ...thread.linkedDirectories.flatMap((directory) => [linkedDirectoryWorktreePath(directory), directory.path])]
    .filter((value): value is string => Boolean(value));
}

export function archiveNotificationWorkspacePaths(thread: Record<string, unknown> | undefined): string[] {
  const directories = Array.isArray(thread?.linkedDirectories) ? thread.linkedDirectories : [];
  return [thread?.projectKey, thread?.cwd, ...directories.flatMap((value) => {
    const directory = readRecord(value);
    return [directory?.path, directory?.worktreePath];
  })].map(readNonEmptyString).filter((value): value is string => Boolean(value));
}

/** Checkouts left in place by a repair pass, counted by a short reason. A
 * checkout that was already gone is not counted: nothing was kept. */
export function archivedWorktreeKeptReasons(report: ArchivedWorktreeRepairReport): Record<string, number> {
  const kept: Record<string, number> = {};
  const add = (reason: string) => { kept[reason] = (kept[reason] ?? 0) + 1; };
  for (const detail of report.protectedWorktreeDetails) {
    add(detail.externallyManaged ? "Externally managed" : "Used by an active thread");
  }
  for (const item of report.cleanup) {
    if (item.removedWorktree || item.error || !item.skippedReason) continue;
    if (item.skippedReason === MISSING_WORKTREE_SKIP_REASON) continue;
    if (item.skippedReason === MISSING_REPOSITORY_SKIP_REASON) add("Repository no longer exists");
    else if (item.skippedReason.includes("still used by")) add("Used by an active thread");
    else if (item.skippedReason.startsWith("Externally managed")) add("Externally managed");
    else add(item.skippedReason.split(":")[0]!.replace(/\.$/, ""));
  }
  return kept;
}

/** How long a reviewed approval to snapshot past the limit stays usable. */
export const REVIEWED_SNAPSHOT_LIMIT_TTL_MS = 30 * 60_000;

export const MISSING_WORKTREE_SKIP_REASON = "Worktree directory no longer exists.";
export const MISSING_REPOSITORY_SKIP_REASON = "Its repository no longer exists; the checkout was kept.";
