import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
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

const unlocked: Lock = { kind: "none" };
const ownLock: Lock = { kind: "pwragent" };
const approvedReason = "release prep, do not remove";
const externalLock: Lock = { kind: "other", reason: approvedReason };
const changedLock: Lock = { kind: "other", reason: "hotfix in progress" };
const anonymousLock: Lock = { kind: "other", reason: "" };

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
  const admissionCases: { label: string; initial: Lock; approved?: string; late?: Lock }[] = [
    { label: "unlocked", initial: unlocked },
    { label: "PwrAgent lock", initial: ownLock },
    { label: "no approval", initial: externalLock, late: unlocked },
    { label: "incorrect approval", initial: externalLock, approved: "release prep" },
    { label: "exact approval", initial: externalLock, approved: approvedReason },
    { label: "empty approval", initial: anonymousLock, approved: "" },
    { label: "missing approval for empty reason", initial: anonymousLock },
    { label: "unlock after approval", initial: externalLock, approved: approvedReason, late: unlocked },
    { label: "relock with the approved reason", initial: externalLock, approved: approvedReason, late: externalLock },
    { label: "relock with a different reason", initial: externalLock, approved: approvedReason, late: changedLock },
    { label: "PwrAgent lock replaced by an external lock", initial: ownLock, late: externalLock },
    { label: "external lock appears after admission", initial: unlocked, late: anonymousLock },
    { label: "PwrAgent lock appears after admission", initial: unlocked, late: ownLock },
  ];
  it.each(admissionCases)(
    "checks the exact approved lock at admission and removal ($label)",
    async ({ initial, approved, late }) => {
      const { root, repo, worktree } = await fixture("pwragent-lock-approval-");
      try {
        await applyLock(repo, worktree, initial);
        await writeFile(path.join(worktree, "work.txt"), "unsaved work\n");
        const final = late ?? initial;
        const archive = new WorktreeArchiveService().archive({
          backend: "codex", threadId: "approval", repositoryPath: repo, worktreePath: worktree,
          ...(approved !== undefined ? { approvedLockReason: approved } : {}),
          beforeRemove: async () => {
            if (late) await setLock(repo, worktree, initial, late);
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
    120_000,
  );

  it.each((["archive", "hibernate", "remove"] as const).flatMap(route =>
    [approvedReason, ""].map(reason => ({ route, reason }))))(
    "keeps another owner's lock in $route without approval (reason=$reason)",
    async ({ reason, route }) => {
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
    120_000,
  );

  const handoffLocks = [
    { label: "unlocked", lock: unlocked },
    { label: "PwrAgent lock", lock: ownLock },
    { label: "unapproved external lock", lock: externalLock },
    { label: "different approval", lock: externalLock, approved: "release prep" },
    { label: "approved external lock", lock: externalLock, approved: approvedReason },
    { label: "unapproved anonymous lock", lock: anonymousLock },
    { label: "approved anonymous lock", lock: anonymousLock, approved: "" },
  ];
  it.each(handoffLocks.flatMap(testCase => [false, true].flatMap(detached =>
    [false, true].map(dirty => ({ ...testCase, detached, dirty })))))(
    "completes Handoff to Local with $label (detached=$detached, dirty=$dirty)",
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
    120_000,
  );

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
