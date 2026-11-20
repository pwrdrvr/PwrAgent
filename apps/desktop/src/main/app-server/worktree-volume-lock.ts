import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Git's own advice for a worktree on a drive that is not always mounted: lock
 * it. `git worktree prune`, and `git gc` after `gc.worktreePruneExpire`, delete
 * the administrative files of a worktree whose folder is missing, and the
 * checkout is then no longer a Git working tree. A worktree on the same volume
 * as its repository cannot go missing that way, so only a cross-volume one is
 * locked. The reason marks the lock as PwrAgent's, so PwrAgent removes only
 * its own lock and never one an operator or another tool set.
 */
export const PWRAGENT_WORKTREE_LOCK_REASON =
  "PwrAgent: on a different drive from its repository; kept while that drive is disconnected";

type GitRunner = (args: string[]) => Promise<unknown>;

export async function isOnSeparateVolume(repoRoot: string, worktreePath: string): Promise<boolean> {
  const [repository, worktree] = await Promise.all([stat(repoRoot), stat(worktreePath)]);
  return repository.dev !== worktree.dev;
}

/**
 * Locks a just-created worktree when it is on a different volume from its
 * repository. Best effort: an unlocked worktree still works, so a failure
 * never fails the creation.
 */
export async function lockWorktreeOnSeparateVolume(params: {
  repoRoot: string;
  worktreePath: string;
  git: GitRunner;
  /** Test seam: one temp directory cannot span two volumes. */
  separateVolume?: (repoRoot: string, worktreePath: string) => Promise<boolean>;
}): Promise<boolean> {
  try {
    const separate = params.separateVolume ?? isOnSeparateVolume;
    if (!await separate(params.repoRoot, params.worktreePath)) return false;
    await params.git(["worktree", "lock", "--reason", PWRAGENT_WORKTREE_LOCK_REASON, params.worktreePath]);
    return true;
  } catch {
    return false;
  }
}

/** A `git worktree list --porcelain` record: `locked` alone, or `locked <reason>`. */
export type WorktreeLockRecord = { locked: boolean; lockReason?: string };

export function isPwrAgentWorktreeLock(record: WorktreeLockRecord): boolean {
  return record.locked && record.lockReason === PWRAGENT_WORKTREE_LOCK_REASON;
}

/**
 * Before PwrAgent removes a worktree: clears PwrAgent's own lock on it, and
 * leaves any other lock in place, so that removal still stops there. Reads
 * only this worktree's `locked` file; listing every worktree per removal
 * would make archiving a fleet quadratic in Git output.
 */
export async function unlockPwrAgentWorktreeLock(params: {
  worktreePath: string;
  /** Runs Git in the repository. */
  git: GitRunner;
}): Promise<boolean> {
  try {
    const pointer = await readFile(path.join(params.worktreePath, ".git"), "utf8");
    const gitDirectory = /^gitdir:\s*(.+)$/m.exec(pointer)?.[1]?.trim();
    if (!gitDirectory) return false;
    const reason = await readFile(path.join(path.resolve(params.worktreePath, gitDirectory), "locked"), "utf8");
    if (reason.trim() !== PWRAGENT_WORKTREE_LOCK_REASON) return false;
    await params.git(["worktree", "unlock", params.worktreePath]);
    return true;
  } catch {
    return false;
  }
}
