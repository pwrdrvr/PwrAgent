import type { LinkedDirectorySummary, WorktreeSnapshotSummary } from "./contracts/normalized-app-server";
import { canonicalizeNavigationPath } from "./directory-navigation";

/**
 * Settings → Worktrees → Hibernate idle checkouts, `[worktrees.hibernate]`.
 * Hibernation removes an idle thread's worktree checkout after saving its
 * uncommitted changes to a recovery snapshot. The thread stays in the lists.
 * It is the automatic way to reclaim disk: on unless the profile set
 * `enabled = false`, since nothing archives threads on a timer.
 */
export type DesktopCheckoutHibernationPolicy = {
  enabled: boolean;
  idleDays: number;
  /** Largest recovery snapshot hibernation writes. Separate from archive's limit. */
  maxSnapshotMb: number;
  /** Legacy config field, normalized to true. Ignored files are excluded
   * from recovery snapshots and removed with a hibernated checkout. */
  removeRebuildableOutput: boolean;
  restoreOn: "send" | "open";
};

export const CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES: readonly number[] = [5, 10, 25, 50, 100];

export const DEFAULT_CHECKOUT_HIBERNATION_POLICY: DesktopCheckoutHibernationPolicy = {
  enabled: true,
  idleDays: 7,
  maxSnapshotMb: 100,
  removeRebuildableOutput: true,
  restoreOn: "send",
};

/** A Claude session idle this long may be gone from Claude Code's own store. */
export const CHECKOUT_HIBERNATION_CLAUDE_MAX_IDLE_DAYS = 30;

/** Fills defaults and clamps each field. Only an explicit `false` turns
 * hibernation off; a profile that never set it gets the default, on. */
export function normalizeCheckoutHibernationPolicy(
  value?: Partial<DesktopCheckoutHibernationPolicy>,
): DesktopCheckoutHibernationPolicy {
  const finite = (input: unknown): input is number => typeof input === "number" && Number.isFinite(input);
  const idleDays = finite(value?.idleDays)
    ? Math.min(3650, Math.max(1, Math.floor(value.idleDays)))
    : DEFAULT_CHECKOUT_HIBERNATION_POLICY.idleDays;
  const maxSnapshotMb = finite(value?.maxSnapshotMb)
    ? CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES.reduce((best, choice) => (choice <= value.maxSnapshotMb! ? choice : best),
      CHECKOUT_HIBERNATION_SNAPSHOT_MB_CHOICES[0]!)
    : DEFAULT_CHECKOUT_HIBERNATION_POLICY.maxSnapshotMb;
  return {
    enabled: value?.enabled !== false,
    idleDays,
    maxSnapshotMb,
    removeRebuildableOutput: true,
    restoreOn: value?.restoreOn === "open" ? "open" : "send",
  };
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
  const target = canonicalizeNavigationPath(worktreePath);
  return (thread.worktreeSnapshots ?? []).some((snapshot) =>
    snapshot.state === "hibernated" && canonicalizeNavigationPath(snapshot.worktreePath) === target);
}
