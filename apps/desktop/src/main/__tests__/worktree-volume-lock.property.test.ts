import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { addManagedWorktree, removeManagedWorktree } from "../app-server/managed-worktree";
import {
  PWRAGENT_WORKTREE_LOCK_REASON,
  lockWorktreeOnSeparateVolume,
  unlockPwrAgentWorktreeLock,
} from "../app-server/worktree-volume-lock";

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

async function fixture(): Promise<{ repo: string; worktree: string; container: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-lock-")));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["-c", "user.name=PwrAgent Tests", "-c", "user.email=tests@example.invalid", "commit", "-q", "--allow-empty", "-m", "seed"]);
  const container = path.join(root, "drive", ".pwragent", "worktrees", "m1abc");
  await mkdir(container, { recursive: true });
  const worktree = path.join(container, "Orbit");
  git(repo, ["worktree", "add", "-q", "--detach", worktree, "HEAD"]);
  return { repo, worktree, container };
}

function record(repo: string, worktree: string): { locked: boolean; lockReason?: string } | undefined {
  // Git prints forward-slash paths on Windows; compare resolved paths.
  const block = git(repo, ["worktree", "list", "--porcelain"]).split(/\r?\n\r?\n/)
    .map((candidate) => candidate.split(/\r?\n/))
    .find((lines) => lines[0]?.startsWith("worktree ")
      && path.resolve(lines[0].slice("worktree ".length)) === path.resolve(worktree));
  if (!block) return undefined;
  const lock = block.find((line) => line === "locked" || line.startsWith("locked "));
  return { locked: lock !== undefined, lockReason: lock?.slice("locked ".length) || undefined };
}

/**
 * Rules: a worktree on a different volume from its repository survives
 * `git worktree prune` while its drive is unplugged; one on the same volume
 * is not locked. Before removing, PwrAgent clears only its own lock, so a
 * lock someone else set still stops the removal.
 */
describe("worktree volume locks", () => {
  it("keeps cross-volume worktrees through a prune while unplugged, and never clears a foreign lock", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), async (separateVolume, foreignLock) => {
        const { repo, worktree, container } = await fixture();
        if (foreignLock) git(repo, ["worktree", "lock", "--reason", "operator hold", worktree]);

        const locked = await lockWorktreeOnSeparateVolume({
          repoRoot: repo,
          worktreePath: worktree,
          git: async (args) => git(repo, args),
          separateVolume: async () => separateVolume,
        });
        expect(locked).toBe(separateVolume && !foreignLock);

        // Unplug the drive: the whole container disappears, then prune runs.
        const unplugged = `${container}-unplugged`;
        await rename(container, unplugged);
        git(repo, ["worktree", "prune"]);
        expect(record(repo, worktree) !== undefined).toBe(separateVolume || foreignLock);
        await rename(unplugged, container);
        if (!record(repo, worktree)) return;

        const cleared = await unlockPwrAgentWorktreeLock({ worktreePath: worktree, git: async (args) => git(repo, args) });
        expect(cleared).toBe(separateVolume && !foreignLock);
        expect(record(repo, worktree)?.locked).toBe(foreignLock);
        if (foreignLock) {
          expect(record(repo, worktree)?.lockReason).toBe("operator hold");
          expect(() => git(repo, ["worktree", "remove", "--force", worktree])).toThrow(/locked/);
        } else {
          git(repo, ["worktree", "remove", "--force", worktree]);
          expect(existsSync(worktree)).toBe(false);
        }
      }),
      { numRuns: 8 },
    );
  });

  it("adds and removes through the helper, even when the checkout folder is gone", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.boolean(), fc.boolean(), async (separateVolume, foreignLock, folderGone) => {
        const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-managed-worktree-")));
        cleanupPaths.push(root);
        const repo = path.join(root, "repo");
        await mkdir(repo);
        git(repo, ["init", "-q", "-b", "main"]);
        git(repo, ["-c", "user.name=PwrAgent Tests", "-c", "user.email=tests@example.invalid", "commit", "-q", "--allow-empty", "-m", "seed"]);
        const container = path.join(root, "drive", ".pwragent", "worktrees", "m1abc");
        await mkdir(container, { recursive: true });
        const worktree = path.join(container, "Orbit");
        const run = async (args: string[]) => git(repo, args);

        await addManagedWorktree({
          repoRoot: repo, worktreePath: worktree, addArgs: ["--detach", worktree, "HEAD"], git: run,
          separateVolume: async () => separateVolume,
        });
        expect(record(repo, worktree)).toMatchObject({ locked: separateVolume });
        if (foreignLock && !separateVolume) git(repo, ["worktree", "lock", "--reason", "operator hold", worktree]);
        const held = foreignLock && !separateVolume;
        // With the folder gone, recovery passes Git's record for the lock.
        if (folderGone) await rm(container, { recursive: true, force: true });
        const removal = removeManagedWorktree({
          worktreePath: worktree, force: !folderGone, git: run, lock: folderGone ? record(repo, worktree) : undefined,
        });

        if (held) {
          await expect(removal).rejects.toThrow(/locked/);
          expect(record(repo, worktree)).toMatchObject({ locked: true, lockReason: "operator hold" });
        } else {
          await removal;
          expect(record(repo, worktree)).toBeUndefined();
        }
      }),
      { numRuns: 16 },
    );
  });

  it("marks the lock with PwrAgent's reason", async () => {
    const { repo, worktree } = await fixture();
    await lockWorktreeOnSeparateVolume({
      repoRoot: repo, worktreePath: worktree, git: async (args) => git(repo, args), separateVolume: async () => true,
    });
    expect(record(repo, worktree)).toMatchObject({ locked: true, lockReason: PWRAGENT_WORKTREE_LOCK_REASON });
  });
});
