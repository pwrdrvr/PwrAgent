import path from "node:path";
import {
  CHECKOUT_HIBERNATION_CLAUDE_MAX_IDLE_DAYS,
  type DesktopCheckoutHibernationPolicy,
  type LinkedDirectorySummary,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import {
  archiveCandidateProtectionReason,
  CLAUDE_CHECKOUT_KEEP_REASON,
  type ThreadArchiveCandidate,
} from "./thread-archive-sweeper";
import { primaryThreadWorktree } from "./missing-thread-workspace";

const DAY_MS = 86_400_000;

export function isArchivedCheckoutCandidate({ thread, overlay }: Pick<ThreadArchiveCandidate, "thread" | "overlay">): boolean {
  return thread.archivedAt !== undefined || overlay?.archiveTombstonedAt !== undefined
    || overlay?.archiveRetentionStartedAt !== undefined;
}

/** A view acknowledgement is conversation activity for archiving, but does
 * not use the checkout. Inspecting a kept thread must not postpone its
 * hibernation again. Actual work and restores still restart the idle clock. */
export function checkoutHibernationLastActivity({ thread, overlay }: ThreadArchiveCandidate): number {
  return Math.max(thread.updatedAt ?? 0, overlay?.archiveRestoredAt ?? 0,
    ...(overlay?.worktreeSnapshots ?? thread.worktreeSnapshots ?? []).map((snapshot) => snapshot.restoredAt ?? 0));
}

/** Keep reasons the hibernation pass reports. Tests and the sweep summary
 * share these strings. */
export const HIBERNATION_KEEP_REASONS = {
  off: "Hibernation is off",
  keptAwake: "Kept awake",
  noWorktree: "No worktree checkout",
  borrowed: CLAUDE_CHECKOUT_KEEP_REASON,
  outsideRoot: "Checkout outside PwrAgent's and Codex's worktrees",
  alreadyHibernated: "Already hibernated",
  archiveRestorePending: "Archive restore not finished",
  activityUnknown: "Activity unknown",
  claudeSessionAge: "Claude session may have expired",
  recentlyActive: "Recently active",
  busy: "Busy",
  shared: "Shared with another thread",
} as const;

/** What the registry knows about a candidate that the thread row does not say. */
export type HibernationContext = {
  /** A turn, queued message, pending request, lifecycle mutation or running
   * environment action. */
  busy: boolean;
  /** Another non-archived thread lists the same checkout. */
  sharedPath: boolean;
};

export type HibernationTarget = {
  directory: LinkedDirectorySummary & { worktreePath: string };
  worktreePath: string;
  repositoryPath: string;
};

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

/** The newest snapshot record for a checkout path. Snapshot ids are per path. */
export function snapshotForPath(
  snapshots: readonly WorktreeSnapshotSummary[] | undefined,
  worktreePath: string,
): WorktreeSnapshotSummary | undefined {
  return [...snapshots ?? []]
    .filter((snapshot) => samePath(snapshot.worktreePath, worktreePath))
    .sort((left, right) => (right.hibernatedAt ?? right.archivedAt ?? right.restoredAt ?? right.createdAt)
      - (left.hibernatedAt ?? left.archivedAt ?? left.restoredAt ?? left.createdAt))[0];
}

/** The hibernated snapshot of the thread's working checkout, if any. */
export function hibernatedSnapshotFor(candidate: Pick<ThreadArchiveCandidate, "thread" | "overlay">): WorktreeSnapshotSummary | undefined {
  const directory = primaryThreadWorktree(candidate.thread);
  if (!directory) return undefined;
  const snapshot = snapshotForPath(candidate.overlay?.worktreeSnapshots ?? candidate.thread.worktreeSnapshots, directory.worktreePath);
  return snapshot?.state === "hibernated" ? snapshot : undefined;
}

/** The thread's working worktree. Location is not an ownership signal; the
 * subsequent Git probe must establish a linked checkout, never a primary. */
export function hibernationTarget(candidate: Pick<ThreadArchiveCandidate, "thread" | "overlay" | "managedWorktreePath">): HibernationTarget | { keep: string } {
  const directory = primaryThreadWorktree(candidate.thread);
  if (!directory) return { keep: HIBERNATION_KEEP_REASONS.noWorktree };
  if (directory.worktreeOwnership === "external"
    && (!candidate.managedWorktreePath || !samePath(directory.worktreePath, candidate.managedWorktreePath))) {
    return { keep: HIBERNATION_KEEP_REASONS.borrowed };
  }
  return { directory, worktreePath: directory.worktreePath, repositoryPath: directory.path };
}

/**
 * Why the policy keeps a candidate's checkout, or undefined when it may be
 * hibernated. This is the thread-level half; the Git probe of the checkout
 * itself (`inspectHibernationWorkspace`) runs only when this passes.
 *
 * Archive's protections apply, except that a pinned thread may hibernate:
 * it stays listed and pinned, only its checkout goes.
 */
export function hibernationKeepReason(
  candidate: ThreadArchiveCandidate,
  now: number,
  policy: DesktopCheckoutHibernationPolicy,
  context: HibernationContext,
): string | undefined {
  const { thread, overlay } = candidate;
  if (!policy.enabled) return HIBERNATION_KEEP_REASONS.off;
  const archived = isArchivedCheckoutCandidate(candidate);
  // Keep it awake: the operator's own exemption, until they turn it off.
  if (overlay?.keepCheckoutAwake) return HIBERNATION_KEEP_REASONS.keptAwake;
  const protection = archiveCandidateProtectionReason(candidate, { allowPinned: true, allowOwnedClaudeWorktree: true });
  if (protection) return protection;
  const target = hibernationTarget(candidate);
  if ("keep" in target) return target.keep;
  const snapshot = snapshotForPath(overlay?.worktreeSnapshots, target.worktreePath);
  if (snapshot?.state === "hibernated") return HIBERNATION_KEEP_REASONS.alreadyHibernated;
  // A snapshot record is per path. One an archive wrote and no restore has
  // finished is the only copy of that work; never overwrite it.
  if (snapshot?.state === "archived" && snapshot.restoredAt === undefined) return HIBERNATION_KEEP_REASONS.archiveRestorePending;
  if (!Number.isFinite(thread.updatedAt) || (thread.updatedAt ?? 0) <= 0) return HIBERNATION_KEEP_REASONS.activityUnknown;
  const idle = now - checkoutHibernationLastActivity(candidate);
  // Claude Code may have deleted an old session, and restoring its checkout
  // would not bring an active conversation back. An archived conversation
  // already has that lifecycle state; it does not require a live SDK session
  // to reclaim its idle checkout.
  if (!archived && thread.source === "claude" && idle > CHECKOUT_HIBERNATION_CLAUDE_MAX_IDLE_DAYS * DAY_MS) {
    return HIBERNATION_KEEP_REASONS.claudeSessionAge;
  }
  if (idle < policy.idleDays * DAY_MS) return HIBERNATION_KEEP_REASONS.recentlyActive;
  if (context.busy) return HIBERNATION_KEEP_REASONS.busy;
  if (context.sharedPath) return HIBERNATION_KEEP_REASONS.shared;
  return undefined;
}

/** Non-archived threads other than `candidate` that list its checkout. */
export function otherThreadsUsingPath(
  candidate: Pick<ThreadArchiveCandidate, "thread">,
  worktreePath: string,
  candidates: readonly Pick<ThreadArchiveCandidate, "thread" | "overlay">[],
): number {
  return candidates.filter(({ thread, overlay }) =>
    !(thread.source === candidate.thread.source && thread.id === candidate.thread.id)
    && thread.archivedAt === undefined && overlay?.archiveTombstonedAt === undefined
    && [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
      .some((directory) => samePath(directory.worktreePath ?? directory.path, worktreePath))).length;
}
