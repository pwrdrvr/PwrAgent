import type { DesktopThreadArchivePolicy } from "./thread-archive-policy";
import type { LinkedDirectorySummary, WorktreeSnapshotSummary } from "./contracts/normalized-app-server";

/**
 * Settings → Worktrees → Hibernate idle checkouts, `[worktrees.hibernate]`.
 * Hibernation removes an idle thread's worktree checkout after saving its
 * uncommitted changes to a recovery snapshot. The thread stays in the lists.
 */
export type DesktopCheckoutHibernationPolicy = {
  enabled: boolean;
  idleDays: number;
  /** Largest recovery snapshot hibernation writes. Separate from archive's limit. */
  maxSnapshotMb: number;
  /** Ignored folders such as node_modules may be removed with the checkout. */
  removeRebuildableOutput: boolean;
  restoreOn: "send" | "open";
};

export const CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES: readonly number[] = [5, 10, 25, 50, 100];

export const DEFAULT_CHECKOUT_HIBERNATION_POLICY: DesktopCheckoutHibernationPolicy = {
  enabled: false,
  idleDays: 7,
  maxSnapshotMb: 100,
  removeRebuildableOutput: true,
  restoreOn: "send",
};

/** A Claude session idle this long may be gone from Claude Code's own store. */
export const CHECKOUT_HIBERNATION_CLAUDE_MAX_IDLE_DAYS = 30;

/**
 * Fills defaults and clamps each field. A checkout must hibernate before its
 * thread would be archived, so while archive runs in "age" mode `idleDays`
 * stays below the archive's inactivity days. With a one-day archive there is
 * no such day, and hibernation is reported off.
 */
export function normalizeCheckoutHibernationPolicy(
  value?: Partial<DesktopCheckoutHibernationPolicy>,
  archivePolicy?: Pick<DesktopThreadArchivePolicy, "enabled" | "mode" | "inactivityDays">,
): DesktopCheckoutHibernationPolicy {
  const finite = (input: unknown): input is number => typeof input === "number" && Number.isFinite(input);
  let idleDays = finite(value?.idleDays)
    ? Math.min(3650, Math.max(1, Math.floor(value.idleDays)))
    : DEFAULT_CHECKOUT_HIBERNATION_POLICY.idleDays;
  let enabled = value?.enabled === true;
  if (archivePolicy?.enabled && archivePolicy.mode === "age") {
    const ceiling = Math.floor(archivePolicy.inactivityDays) - 1;
    if (ceiling < 1) enabled = false;
    else idleDays = Math.min(idleDays, ceiling);
  }
  const maxSnapshotMb = finite(value?.maxSnapshotMb)
    ? CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES.reduce((best, choice) => (choice <= value.maxSnapshotMb! ? choice : best),
      CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES[0]!)
    : DEFAULT_CHECKOUT_HIBERNATION_POLICY.maxSnapshotMb;
  return {
    enabled,
    idleDays,
    maxSnapshotMb,
    removeRebuildableOutput: value?.removeRebuildableOutput ?? DEFAULT_CHECKOUT_HIBERNATION_POLICY.removeRebuildableOutput,
    restoreOn: value?.restoreOn === "open" ? "open" : "send",
  };
}

function comparableWorktreePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Whether the thread's own worktree checkout is hibernated: its first
 * worktree directory has a hibernated snapshot, and the thread is not archived. */
export function isThreadCheckoutHibernated(thread: {
  linkedDirectories: readonly LinkedDirectorySummary[];
  worktreeSnapshots?: readonly WorktreeSnapshotSummary[];
  archivedAt?: number;
}): boolean {
  if (thread.archivedAt !== undefined) return false;
  const worktreePath = thread.linkedDirectories.find((directory) => directory.kind === "worktree")?.worktreePath;
  if (!worktreePath) return false;
  const target = comparableWorktreePath(worktreePath);
  return (thread.worktreeSnapshots ?? []).some((snapshot) =>
    snapshot.state === "hibernated" && comparableWorktreePath(snapshot.worktreePath) === target);
}
