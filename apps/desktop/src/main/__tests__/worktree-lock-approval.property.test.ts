import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";
import { removeManagedWorktree } from "../app-server/managed-worktree";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";
import { PWRAGENT_WORKTREE_LOCK_REASON, WorktreeLockedError } from "../app-server/worktree-volume-lock";

/*
 * Rules from the locked-worktree removal design (D2–D5):
 * - Someone else's lock is cleared only with the operator's approval, and
 *   only while the lock still says exactly what they approved. Anything else
 *   (unlocked and relocked, a new reason) keeps the worktree, still locked.
 * - Paths that never carry an approval (hibernation, archive without one,
 *   PwrAgent's removal helper) never clear someone else's lock.
 * - A handoff from a worktree someone else locked never fails after Git has
 *   moved: it keeps the worktree, or archives it when approved.
 * Real Git is the oracle for what is on disk and what is locked.
 */

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-c", "maintenance.autoDetach=false", "-c", "gc.autoDetach=false", "-C", cwd, ...args,
  ], { encoding: "utf8" });
  return stdout.trim();
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type Lock = { kind: "none" } | { kind: "pwragent" } | { kind: "other"; reason: string };

const reasonArb = fc.oneof(
  fc.constantFrom("release prep, do not remove", "", "keep"),
  fc.stringMatching(/^[a-z][a-z ,]{0,16}[a-z]$/),
);
const lockArb: fc.Arbitrary<Lock> = fc.oneof(
  fc.constant<Lock>({ kind: "none" }),
  fc.constant<Lock>({ kind: "pwragent" }),
  reasonArb.map((reason): Lock => ({ kind: "other", reason })),
);
const approvalArb = (lock: Lock): fc.Arbitrary<string | undefined> => fc.oneof(
  fc.constant(undefined),
  // The text the operator saw.
  fc.constant(lock.kind === "other" ? lock.reason : PWRAGENT_WORKTREE_LOCK_REASON),
  reasonArb,
);

async function applyLock(repo: string, worktree: string, lock: Lock): Promise<void> {
  if (lock.kind === "none") return;
  const reason = lock.kind === "pwragent" ? PWRAGENT_WORKTREE_LOCK_REASON : lock.reason;
  await git(repo, ["worktree", "lock", ...(reason ? ["--reason", reason] : []), worktree]);
}

async function setLock(repo: string, worktree: string, from: Lock, to: Lock): Promise<void> {
  if (from.kind !== "none") await git(repo, ["worktree", "unlock", worktree]);
  await applyLock(repo, worktree, to);
}

/** What Git's `locked` file says now, by the same classification. */
async function readLock(worktree: string): Promise<Lock> {
  const pointer = await readFile(path.join(worktree, ".git"), "utf8");
  const gitDirectory = path.resolve(worktree, /^gitdir:\s*(.+)$/m.exec(pointer)![1]!.trim());
  let text: string;
  try {
    text = (await readFile(path.join(gitDirectory, "locked"), "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    throw error;
  }
  return text === PWRAGENT_WORKTREE_LOCK_REASON ? { kind: "pwragent" } : { kind: "other", reason: text };
}

/** The oracle: a lock lets removal through when it is not someone else's, or is exactly the approved one. */
function admits(lock: Lock, approved: string | undefined): boolean {
  return lock.kind !== "other" || (approved !== undefined && lock.reason === approved);
}

async function fixture(prefix: string): Promise<{ root: string; repo: string; worktree: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  await git(repo, ["init", "-b", "main"]);
  await git(repo, ["config", "core.autocrlf", "false"]);
  await git(repo, ["config", "user.email", "fixture@example.invalid"]);
  await git(repo, ["config", "user.name", "Fixture"]);
  await writeFile(path.join(repo, "README.md"), "main\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["branch", "feature"]);
  const worktree = path.join(root, "worktree");
  await git(repo, ["worktree", "add", worktree, "feature"]);
  return { root, repo, worktree };
}

describe("someone else's worktree lock", () => {
  it("is cleared only while it still says exactly what the operator approved", async () => {
    await fc.assert(fc.asyncProperty(
      lockArb.chain((initial) => fc.record({
        initial: fc.constant(initial),
        approved: approvalArb(initial),
        // What the lock says by the time PwrAgent removes the checkout.
        late: fc.oneof(fc.constant<Lock | "unchanged">("unchanged"), lockArb),
      })),
      async ({ initial, approved, late }) => {
        const { root, repo, worktree } = await fixture("pwragent-lock-approval-");
        try {
          await applyLock(repo, worktree, initial);
          await writeFile(path.join(worktree, "work.txt"), "unsaved work\n");
          const final = late === "unchanged" ? initial : late;
          const archive = new WorktreeArchiveService().archive({
            backend: "codex", threadId: "approval", repositoryPath: repo, worktreePath: worktree,
            ...(approved !== undefined ? { approvedLockReason: approved } : {}),
            beforeRemove: async () => {
              if (late !== "unchanged") await setLock(repo, worktree, initial, late);
              return () => {};
            },
          });
          // Admission reads the lock first; removal reads it again.
          const refusedBy = !admits(initial, approved) ? initial : !admits(final, approved) ? final : undefined;
          if (refusedBy) {
            const error = await archive.then(() => undefined, (caught: unknown) => caught);
            expect(error).toBeInstanceOf(WorktreeLockedError);
            expect(error).toMatchObject({ lockReason: refusedBy.kind === "other" ? refusedBy.reason : "" });
            expect(await readFile(path.join(worktree, "work.txt"), "utf8")).toBe("unsaved work\n");
            // Refused at admission, the late change never ran.
            expect(await readLock(worktree)).toEqual(!admits(initial, approved) ? initial : final);
          } else {
            const snapshot = await archive;
            expect(await exists(worktree)).toBe(false);
            expect(await git(repo, ["show", `${snapshot.snapshotRef}:work.txt`])).toBe("unsaved work");
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    ), { numRuns: 30 });
  }, 120_000);

  it("is never cleared by a path that carries no approval", async () => {
    await fc.assert(fc.asyncProperty(
      reasonArb,
      fc.constantFrom("archive", "hibernate", "remove"),
      async (reason, route) => {
        const { root, repo, worktree } = await fixture("pwragent-lock-automatic-");
        try {
          const lock: Lock = { kind: "other", reason };
          await applyLock(repo, worktree, lock);
          const service = new WorktreeArchiveService();
          const attempt = route === "archive"
            ? service.archive({ backend: "codex", threadId: "auto", repositoryPath: repo, worktreePath: worktree })
            : route === "hibernate"
              ? service.hibernate({ backend: "codex", threadId: "auto", repositoryPath: repo, worktreePath: worktree,
                capSnapshotBytes: 1024 * 1024, beforeRemove: async () => () => {} })
              : removeManagedWorktree({ worktreePath: worktree, force: true, git: async (args) => await git(repo, args) });
          await expect(attempt).rejects.toThrow();
          expect(await exists(worktree)).toBe(true);
          expect(await readLock(worktree)).toEqual(lock);
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    ), { numRuns: 20 });
  }, 120_000);

  it("never makes Handoff to Local fail after Git has moved", async () => {
    await fc.assert(fc.asyncProperty(
      lockArb.chain((lock) => fc.record({
        lock: fc.constant(lock),
        approved: approvalArb(lock),
        detached: fc.boolean(),
        dirty: fc.boolean(),
      })),
      async ({ lock, approved, detached, dirty }) => {
        const { root, repo, worktree } = await fixture("pwragent-lock-handoff-");
        try {
          if (detached) await git(worktree, ["switch", "--detach"]);
          if (dirty) await writeFile(path.join(worktree, "README.md"), "moved work\n");
          await applyLock(repo, worktree, lock);
          const result = await new GitWorkspaceHandoffService().handoff({
            backend: "codex", threadId: "handoff", direction: "worktree-to-local",
            repositoryPath: repo, sourcePath: worktree, ...(detached ? {} : { sourceBranch: "feature" }), now: 1,
            ...(approved !== undefined ? { approvedLockReason: approved } : {}),
          });
          // The handoff completed: Local has the work.
          expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe(dirty ? "moved work\n" : "main\n");
          if (!detached) expect(await git(repo, ["branch", "--show-current"])).toBe("feature");
          if (admits(lock, approved)) {
            expect(result.archivedSourceWorktree).toBeDefined();
            expect(result.keptSourceWorktree).toBeUndefined();
            expect(await exists(worktree)).toBe(false);
          } else {
            expect(result.archivedSourceWorktree).toBeUndefined();
            expect(result.keptSourceWorktree).toEqual({
              reason: "worktree-locked", worktreePath: worktree, lockReason: lock.kind === "other" ? lock.reason : "",
            });
            expect(await readLock(worktree)).toEqual(lock);
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
    ), { numRuns: 25 });
  }, 120_000);

  it("keeps the worktree when the lock got a new reason after the operator approved", async () => {
    const { root, repo, worktree } = await fixture("pwragent-lock-relocked-");
    try {
      await applyLock(repo, worktree, { kind: "other", reason: "release prep, do not remove" });
      const archive = new WorktreeArchiveService().archive({
        backend: "codex", threadId: "relocked", repositoryPath: repo, worktreePath: worktree,
        approvedLockReason: "release prep, do not remove",
        beforeRemove: async () => {
          await setLock(repo, worktree, { kind: "other", reason: "x" }, { kind: "other", reason: "hotfix in progress" });
          return () => {};
        },
      });
      await expect(archive).rejects.toMatchObject({ name: "WorktreeLockedError", lockReason: "hotfix in progress" });
      expect(await readLock(worktree)).toEqual({ kind: "other", reason: "hotfix in progress" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
