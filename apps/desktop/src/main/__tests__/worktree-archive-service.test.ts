import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeArchiveService } from "../app-server/worktree-archive-service";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
  });
  return stdout.trim();
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

describe("WorktreeArchiveService", () => {
  it("snapshots tracked and untracked worktree changes, removes the worktree, and restores it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-archive-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "repo-feature");
    await mkdir(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
    await writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n", "utf8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["worktree", "add", "-b", "feature/archive", worktreePath, "main"]);

    await writeFile(path.join(worktreePath, "README.md"), "dirty readme\n", "utf8");
    await writeFile(path.join(worktreePath, "notes.txt"), "untracked note\n", "utf8");
    await mkdir(path.join(worktreePath, "node_modules"));
    await writeFile(path.join(worktreePath, "node_modules", "left-out.txt"), "ignored\n", "utf8");

    const service = new WorktreeArchiveService();
    const snapshot = await service.archive({
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: repoPath,
      now: 1000,
    });

    expect(snapshot.state).toBe("archived");
    expect(snapshot.snapshotRef).toMatch(/^refs\/codex\/snapshots\//);
    expect(await pathExists(worktreePath)).toBe(false);
    expect(await git(repoPath, ["rev-parse", snapshot.snapshotRef])).toBe(
      snapshot.snapshotCommit,
    );
    expect(await git(repoPath, ["branch", "--list", "feature/archive"])).toContain(
      "feature/archive",
    );

    const restored = await service.restore({
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: repoPath,
      snapshotRef: snapshot.snapshotRef,
      snapshotCommit: snapshot.snapshotCommit,
      snapshot,
      now: 2000,
    });

    expect(restored.state).toBe("restored");
    await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toBe(
      "dirty readme\n",
    );
    await expect(readFile(path.join(worktreePath, "notes.txt"), "utf8")).resolves.toBe(
      "untracked note\n",
    );
    expect(await pathExists(path.join(worktreePath, "node_modules", "left-out.txt"))).toBe(
      false,
    );
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  it("resolves the primary repository when the repository path points at the worktree", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-archive-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "repo-feature");
    await mkdir(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["worktree", "add", "--detach", worktreePath, "main"]);

    const service = new WorktreeArchiveService();
    const snapshot = await service.archive({
      backend: "codex",
      threadId: "thread-1",
      repositoryPath: worktreePath,
      worktreePath,
      now: 1000,
    });

    expect(snapshot.repositoryPath).toBe(await realpath(repoPath));
    expect(await pathExists(worktreePath)).toBe(false);
  });

  it("restores a detached worktree from the retained snapshot commit when the snapshot ref is missing", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-archive-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "repo-feature");
    await mkdir(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["worktree", "add", "-b", "feature/archive", worktreePath, "main"]);
    await writeFile(path.join(worktreePath, "README.md"), "snapshot contents\n", "utf8");

    const service = new WorktreeArchiveService();
    const snapshot = await service.archive({
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: repoPath,
      now: 1000,
    });
    await git(repoPath, ["update-ref", "-d", snapshot.snapshotRef]);

    const restored = await service.restore({
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: repoPath,
      snapshotRef: snapshot.snapshotRef,
      snapshotCommit: snapshot.snapshotCommit,
      snapshot,
      allowDetachedFallback: true,
      now: 2000,
    });

    expect(restored.state).toBe("restored");
    expect(restored.snapshotCommit).toBe(snapshot.snapshotCommit);
    expect(restored.unavailableReason).toContain("retained snapshot commit");
    await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toBe(
      "snapshot contents\n",
    );
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });

  it("restores a detached worktree from an existing branch when no archive snapshot exists", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-archive-"));
    const repoPath = path.join(root, "repo");
    const worktreePath = path.join(root, "restored-worktree");
    await mkdir(repoPath);
    await git(repoPath, ["init", "-b", "main"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "Test User"]);
    await writeFile(path.join(repoPath, "README.md"), "base\n", "utf8");
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-m", "initial"]);
    await git(repoPath, ["switch", "-c", "fix/float-over-hitbox"]);
    await writeFile(path.join(repoPath, "README.md"), "branch work\n", "utf8");
    await git(repoPath, ["commit", "-am", "branch work"]);
    const branchCommit = await git(repoPath, ["rev-parse", "fix/float-over-hitbox"]);

    const service = new WorktreeArchiveService();
    const restored = await service.restoreDetached({
      backend: "codex",
      threadId: "thread-1",
      worktreePath,
      repositoryPath: repoPath,
      restoreRef: "fix/float-over-hitbox",
      now: 2000,
    });

    expect(restored.state).toBe("restored");
    expect(restored.snapshotRef).toBe("fix/float-over-hitbox");
    expect(restored.snapshotCommit).toBe(branchCommit);
    await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toBe(
      "branch work\n",
    );
    expect(await git(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
  });
});
