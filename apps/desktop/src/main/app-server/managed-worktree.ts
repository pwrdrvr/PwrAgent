import {
  isPwrAgentWorktreeLock,
  lockWorktreeOnSeparateVolume,
  unlockPwrAgentWorktreeLock,
  type WorktreeLockRecord,
} from "./worktree-volume-lock";

/**
 * The one place the desktop main process runs `git worktree add` and
 * `git worktree remove`, so every PwrAgent worktree gets its drive lock and
 * every removal clears it. `managed-worktree-guard.test.ts` fails on a raw
 * add or remove anywhere else. Each caller passes its own Git runner, which
 * keeps its environment and process ownership.
 */
type GitRunner<T> = (args: string[]) => Promise<T>;

/**
 * Runs `git worktree add <addArgs>`, then locks the new worktree when it is
 * on a different drive from its repository (best effort; never fails the
 * add). `addArgs` must name `worktreePath`.
 */
export async function addManagedWorktree<T>(params: {
  repoRoot: string;
  worktreePath: string;
  addArgs: string[];
  git: GitRunner<T>;
  /** Test seam: one temp directory cannot span two volumes. */
  separateVolume?: (repoRoot: string, worktreePath: string) => Promise<boolean>;
}): Promise<T> {
  const result = await params.git(["worktree", "add", ...params.addArgs]);
  await lockWorktreeOnSeparateVolume({
    repoRoot: params.repoRoot,
    worktreePath: params.worktreePath,
    git: params.git,
    separateVolume: params.separateVolume,
  });
  return result;
}

/**
 * Clears PwrAgent's own drive lock, then runs `git worktree remove`. Any
 * other lock stays, so Git still refuses the removal.
 *
 * `lock` is the worktree's record from `git worktree list --porcelain`. Pass
 * it when the checkout folder may be gone: the lock is then read from the
 * record instead of from the folder's `.git` pointer.
 */
export async function removeManagedWorktree<T>(params: {
  worktreePath: string;
  git: GitRunner<T>;
  force?: boolean;
  lock?: WorktreeLockRecord;
  /**
   * Runs the remove itself when it needs options the unlock must not get,
   * such as process-tree ownership with a spawn hook. Defaults to `git`.
   */
  removeGit?: GitRunner<T>;
}): Promise<T> {
  if (params.lock) {
    if (isPwrAgentWorktreeLock(params.lock)) {
      await params.git(["worktree", "unlock", params.worktreePath]);
    }
  } else {
    await unlockPwrAgentWorktreeLock({ worktreePath: params.worktreePath, git: params.git });
  }
  const removeGit = params.removeGit ?? params.git;
  return await removeGit(["worktree", "remove", ...(params.force ? ["--force"] : []), params.worktreePath]);
}

/**
 * For a worktree another package adds (the federation handoff import, which
 * cannot import desktop code): the drive lock `addManagedWorktree` applies.
 */
export async function lockExternallyAddedWorktree(params: {
  repoRoot: string;
  worktreePath: string;
  git: GitRunner<unknown>;
}): Promise<void> {
  await lockWorktreeOnSeparateVolume(params);
}

/** Before that package's own code removes such a worktree: clears PwrAgent's drive lock. */
export async function unlockBeforeExternalRemoval(params: {
  worktreePath: string;
  git: GitRunner<unknown>;
}): Promise<void> {
  await unlockPwrAgentWorktreeLock(params);
}
