import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { refreshReviewBaseBranch } from "../app-server/review-base-branch";

const execFile = promisify(execFileCallback);

describe("refreshReviewBaseBranch", () => {
  it("excludes already merged changes from a stale remote base review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-base-"));
    const remote = path.join(root, "remote.git");
    const source = path.join(root, "source");
    const reviewer = path.join(root, "reviewer");
    const git = async (...args: string[]) =>
      (await execFile("git", args, { cwd: root })).stdout.trim();
    try {
      await git("init", "--bare", "--initial-branch=main", remote);
      await git("init", "--initial-branch=main", source);
      await git("-C", source, "config", "user.name", "Test");
      await git("-C", source, "config", "user.email", "test@example.com");
      await writeFile(path.join(source, "base.txt"), "base\n");
      await git("-C", source, "add", "base.txt");
      await git("-C", source, "commit", "-m", "base");
      const oldBase = await git("-C", source, "rev-parse", "HEAD");
      await git("-C", source, "remote", "add", "origin", remote);
      await git("-C", source, "push", "-u", "origin", "main");
      await git("clone", remote, reviewer);

      await writeFile(path.join(source, "merged.txt"), "already merged\n");
      await git("-C", source, "add", "merged.txt");
      await git("-C", source, "commit", "-m", "merged change");
      const currentBase = await git("-C", source, "rev-parse", "HEAD");
      await git("-C", source, "push", "origin", "main");
      // Fetch the object without advancing the reviewer's remote-tracking ref.
      await git("-C", reviewer, "fetch", "--no-write-fetch-head", "origin", currentBase);
      await git("-C", reviewer, "checkout", "-b", "feature", currentBase);
      await git("-C", reviewer, "config", "user.name", "Test");
      await git("-C", reviewer, "config", "user.email", "test@example.com");
      await writeFile(path.join(reviewer, "feature.txt"), "review this\n");
      await git("-C", reviewer, "add", "feature.txt");
      await git("-C", reviewer, "commit", "-m", "feature");

      expect(await git("-C", reviewer, "merge-base", "origin/main", "HEAD"))
        .toBe(oldBase);
      expect(await git("-C", reviewer, "diff", "--name-only", "origin/main...HEAD"))
        .toContain("merged.txt");
      await refreshReviewBaseBranch({
        cwd: reviewer,
        target: { type: "baseBranch", branch: "origin/main" },
      });
      expect(await git("-C", reviewer, "merge-base", "origin/main", "HEAD"))
        .toBe(currentBase);
      expect(await git("-C", reviewer, "diff", "--name-only", "origin/main...HEAD"))
        .toBe("feature.txt");

      await git("-C", reviewer, "update-ref", "refs/remotes/origin/main", oldBase);
      await refreshReviewBaseBranch({
        cwd: reviewer,
        target: { type: "baseBranch", branch: "refs/remotes/origin/main" },
      });
      expect(await git("-C", reviewer, "merge-base", "refs/remotes/origin/main", "HEAD"))
        .toBe(currentBase);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not fetch a local branch named like a remote-tracking ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-review-local-base-"));
    const git = async (...args: string[]) =>
      (await execFile("git", args, { cwd: root })).stdout.trim();
    try {
      await git("init", "--initial-branch=main");
      await git("config", "user.name", "Test");
      await git("config", "user.email", "test@example.com");
      await writeFile(path.join(root, "base.txt"), "base\n");
      await git("add", "base.txt");
      await git("commit", "-m", "base");
      await git("branch", "origin/topic");
      await git("remote", "add", "origin", path.join(root, "missing.git"));
      await git("update-ref", "refs/remotes/origin/topic", "HEAD");

      expect(await git("show-ref", "--verify", "refs/heads/origin/topic"))
        .toContain("refs/heads/origin/topic");
      await expect(refreshReviewBaseBranch({
        cwd: root,
        target: { type: "baseBranch", branch: "origin/topic" },
      })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops the review when the remote base cannot be refreshed", async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === "rev-parse") return { stdout: "refs/remotes/origin/main\n" };
      if (args[0] === "remote") return { stdout: "origin\n" };
      if (args[0] === "check-ref-format") return { stdout: "" };
      throw new Error("offline");
    });
    await expect(refreshReviewBaseBranch({
      cwd: "/worktree",
      target: { type: "baseBranch", branch: "origin/main" },
      runGit,
    })).rejects.toThrow("could not refresh 'origin/main'");
  });

  it("leaves local branches and remote execution workspaces alone", async () => {
    const runGit = vi.fn(async () => ({ stdout: "origin\n" }));
    await refreshReviewBaseBranch({
      cwd: "/worktree",
      target: { type: "baseBranch", branch: "main" },
      runGit,
    });
    await refreshReviewBaseBranch({
      cwd: "/remote/worktree",
      executionTarget: "remote",
      target: { type: "baseBranch", branch: "origin/main" },
      runGit,
    });
    expect(runGit).not.toHaveBeenCalled();
  });
});
