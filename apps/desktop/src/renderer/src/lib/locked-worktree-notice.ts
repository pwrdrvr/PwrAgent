import type {
  AppServerBackendKind,
  ArchiveThreadCleanupResult,
  RemoveLockedThreadWorktreeResponse,
  WorktreeLockedKept,
} from "@pwragent/shared/contracts/normalized-app-server";
import type { FederationTarget } from "@pwragent/shared/contracts/federation";
import type { ArchiveThreadNotice } from "./archive-cleanup-notice";

/** An archived thread's worktree that Git has locked by someone else, kept on disk. */
export type LockedArchiveWorktree = {
  backend: AppServerBackendKind;
  threadId: string;
  threadTitle?: string;
  kept: WorktreeLockedKept;
  /** False for a remote owner: Unlock and Remove runs only where the thread lives. */
  unlockable: boolean;
  /** The lock changed after the operator was last shown it. */
  changed?: boolean;
};

export function collectLockedArchiveWorktrees(
  cleanup: readonly ArchiveThreadCleanupResult[],
  owner: { backend: AppServerBackendKind; threadId: string; threadTitle?: string; federationTarget?: FederationTarget },
): LockedArchiveWorktree[] {
  return cleanup.flatMap((item) => item.kept && !item.removedWorktree ? [{
    backend: owner.backend,
    threadId: owner.threadId,
    ...(owner.threadTitle ? { threadTitle: owner.threadTitle } : {}),
    kept: item.kept,
    unlockable: owner.federationTarget?.scope !== "remote",
  }] : []);
}

/** One entry per worktree; a later report of the same worktree replaces an earlier one. */
export function mergeLockedArchiveWorktrees(
  current: readonly LockedArchiveWorktree[],
  added: readonly LockedArchiveWorktree[],
): LockedArchiveWorktree[] {
  const byPath = new Map(current.map((item) => [item.kept.worktreePath, item]));
  for (const item of added) byPath.set(item.kept.worktreePath, item);
  return [...byPath.values()];
}

function lockText(lockReason: string): string {
  return lockReason ? `Locked: ${lockReason}` : "Locked, with no reason given";
}

/**
 * Archive Thread kept these worktrees because Git has them locked by someone
 * else. Nothing blocks the archive; doing nothing leaves them on disk.
 * Unlock and Remove sends each lock reason exactly as shown here.
 */
export function formatLockedWorktreeNotice(
  items: readonly LockedArchiveWorktree[],
  handlers: { onUnlockAndRemove: () => void; onKeep: () => void },
  failed?: ArchiveThreadNotice,
): ArchiveThreadNotice | undefined {
  const first = items[0];
  if (!first) return failed;
  const changed = items.some((item) => item.changed);
  const title = items.length === 1 ? "Worktree kept: Git has it locked" : "Worktrees kept: Git has them locked";
  const name = first.threadTitle ? `“${first.threadTitle}”` : "The thread";
  const message = changed
    ? "The lock changed after you saw it, so the worktree was kept. Check the new reason before removing it."
    : items.length === 1
      ? first.kept.lockReason
        ? `${name} is archived. Its worktree is locked: ${first.kept.lockReason}`
        : `${name} is archived. Its worktree is locked.`
      : `${items.length} archived threads kept their worktrees because Git has them locked.`;
  const facts = [
    ...items.map((item, index) => ({
      label: items.length === 1 ? "Worktree" : item.threadTitle ?? `Worktree ${index + 1}`,
      value: [item.kept.worktreePath, lockText(item.kept.lockReason)].join("\n"),
    })),
    ...(failed?.facts ?? []),
  ];
  const unlockable = items.some((item) => item.unlockable);
  return {
    ...failed,
    id: ["locked-worktrees", ...items.map((item) => `${item.kept.worktreePath}\n${item.kept.lockReason}`)].join("\n"),
    title,
    message,
    facts,
    autoDismiss: false,
    tone: "warning",
    actions: unlockable
      ? [
          { label: "Unlock and Remove", tone: "primary", onClick: handlers.onUnlockAndRemove },
          { label: "Keep", tone: "secondary", onClick: handlers.onKeep },
        ]
      : undefined,
    copyText: [title, message, ...facts.map((fact) => fact.value), ...(failed?.copyText ? [failed.copyText] : [])].join("\n"),
  };
}

/** What Unlock and Remove did, for the worktrees it was asked to remove. */
export function lockedWorktreeRemovalOutcome(
  items: readonly LockedArchiveWorktree[],
  responses: readonly (RemoveLockedThreadWorktreeResponse | { status: "failed"; worktreePath: string; message: string })[],
): { relocked: LockedArchiveWorktree[]; notice?: ArchiveThreadNotice } {
  const relocked: LockedArchiveWorktree[] = [];
  const problems: { label: string; value: string }[] = [];
  let removed = 0;
  responses.forEach((response, index) => {
    const item = items[index]!;
    if (response.status === "removed") removed += 1;
    else if (response.status === "kept" && response.kept) relocked.push({ ...item, kept: response.kept, changed: true });
    else problems.push({
      label: item.threadTitle ?? "Worktree",
      value: [item.kept.worktreePath, response.status === "kept" ? `Kept: ${response.reason}` : response.message].join("\n"),
    });
  });
  if (problems.length === 0) {
    return {
      relocked,
      ...(relocked.length === 0 && removed > 0 ? { notice: {
        id: `locked-worktrees-removed\n${items.map((item) => item.kept.worktreePath).join("\n")}`,
        title: removed === 1 ? "Worktree removed" : "Worktrees removed",
        message: removed === 1 ? "PwrAgent unlocked it, saved a checkpoint of its changes, and removed it."
          : `PwrAgent unlocked ${removed} worktrees, saved a checkpoint of their changes, and removed them.`,
        tone: "success",
        autoDismiss: true,
      } } : {}),
    };
  }
  const title = "Worktree not removed";
  const message = "PwrAgent could not remove every worktree you chose. They are still on disk.";
  return {
    relocked,
    notice: { id: `locked-worktrees-problem\n${problems.map((fact) => fact.value).join("\n")}`, title, message,
      facts: problems, tone: "error", autoDismiss: false, copyText: [title, message, ...problems.map((fact) => fact.value)].join("\n") },
  };
}

/**
 * The operator chose to unlock the worktree a handoff left, but its lock
 * changed first, so the owner kept it. The handoff itself completed.
 */
export function lockChangedBeforeHandoffNotice(kept: WorktreeLockedKept): ArchiveThreadNotice {
  const title = "Worktree kept: the lock changed";
  const message = "The handoff completed. Git's lock on the previous worktree changed after you chose to unlock it, so it stays on disk.";
  const facts = [{ label: "Worktree", value: [kept.worktreePath, lockText(kept.lockReason)].join("\n") }];
  return {
    id: `locked-worktree-handoff\n${kept.worktreePath}\n${kept.lockReason}`,
    title, message, facts, tone: "warning", autoDismiss: false,
    copyText: [title, message, ...facts.map((fact) => fact.value)].join("\n"),
  };
}
