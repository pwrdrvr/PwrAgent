import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Git's own advice for a worktree on a drive that is not always mounted: lock
 * it. `git worktree prune`, and `git gc` after `gc.worktreePruneExpire`, delete
 * the administrative files of a worktree whose folder is missing, and the
 * checkout is then no longer a Git working tree. Only a worktree whose drive
 * can go away while its repository stays needs that: see `needsDriveLock`.
 * The reason marks the lock as PwrAgent's, so PwrAgent removes only its own
 * lock and never one an operator or another tool set. Keep the text: existing
 * locks are recognized by it.
 */
export const PWRAGENT_WORKTREE_LOCK_REASON =
  "PwrAgent: on a different drive from its repository; kept while that drive is disconnected";

type GitRunner = (args: string[]) => Promise<unknown>;

/**
 * A worktree needs the lock only when its volume can be unplugged while the
 * repository stays: different from the repository's volume (a prune runs in
 * the repository, so a worktree beside it never looks missing) and from the
 * home folder's, which is always mounted. A worktree in $CODEX_HOME/worktrees
 * for a repository on an external drive is not locked: nothing can prune it
 * while the repository is reachable, and a lock there would stop Codex
 * Desktop and the operator from removing it with plain Git.
 */
export function needsDriveLock(devices: { repository: number; worktree: number; home: number }): boolean {
  return devices.worktree !== devices.repository && devices.worktree !== devices.home;
}

export async function isOnSeparateVolume(
  repoRoot: string,
  worktreePath: string,
  homeDir: string = os.homedir(),
): Promise<boolean> {
  const [repository, worktree, home] = await Promise.all([stat(repoRoot), stat(worktreePath), stat(homeDir)]);
  return needsDriveLock({ repository: repository.dev, worktree: worktree.dev, home: home.dev });
}

/**
 * Locks a just-created worktree when `needsDriveLock` says its drive can go
 * away while its repository stays. Best effort: an unlocked worktree still
 * works, so a failure never fails the creation.
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
 * Who holds the lock in a worktree's own Git directory. `pwragent` is only
 * PwrAgent's drive lock: PwrAgent's removal clears it first, so it must never
 * stop archiving or hibernation. `other` is an operator's or another tool's
 * hold, which must. A `locked` entry that cannot be read as a file counts as
 * `other`.
 */
export async function readWorktreeLockHolder(gitDirectory: string): Promise<"none" | "pwragent" | "other"> {
  let reason: string;
  try {
    reason = await readFile(path.join(gitDirectory, "locked"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "none";
    if ((error as NodeJS.ErrnoException).code === "EISDIR") return "other";
    throw error;
  }
  return reason.trim() === PWRAGENT_WORKTREE_LOCK_REASON ? "pwragent" : "other";
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
    if (await readWorktreeLockHolder(path.resolve(params.worktreePath, gitDirectory)) !== "pwragent") return false;
    await params.git(["worktree", "unlock", params.worktreePath]);
    return true;
  } catch {
    return false;
  }
}
