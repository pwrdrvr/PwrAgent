import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

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

async function createRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragnt-handoff-"));
  cleanupPaths.push(root);
  const repoPath = path.join(root, "PwrAgnt");
  await mkdir(repoPath);
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(path.join(repoPath, "README.md"), "main\n", "utf8");
  await writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n", "utf8");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-m", "initial"]);
  await git(repoPath, ["switch", "-c", "feature/handoff"]);
  await writeFile(path.join(repoPath, "feature.txt"), "feature\n", "utf8");
  await git(repoPath, ["add", "feature.txt"]);
  await git(repoPath, ["commit", "-m", "feature"]);
  return repoPath;
}

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

describe("GitWorkspaceHandoffService", () => {
  it("moves a dirty local branch to a new worktree and leaves local on the selected branch", async () => {
    const repoPath = await createRepo();
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");
    await writeFile(path.join(repoPath, "notes.txt"), "untracked\n", "utf8");
    await mkdir(path.join(repoPath, "node_modules"));
    await writeFile(path.join(repoPath, "node_modules", "ignored.txt"), "ignored\n", "utf8");

    const service = new GitWorkspaceHandoffService();
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "main",
      now: 1000,
    });

    expect(result.workMode).toBe("worktree");
    expect(result.linkedDirectory.kind).toBe("worktree");
    expect(result.sourceStash).toMatchObject({ applied: true, dropped: true });
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("main");
    expect(await git(result.targetPath, ["branch", "--show-current"])).toBe(
      "feature/handoff",
    );
    await expect(readFile(path.join(result.targetPath, "README.md"), "utf8")).resolves.toBe(
      "dirty local\n",
    );
    await expect(readFile(path.join(result.targetPath, "notes.txt"), "utf8")).resolves.toBe(
      "untracked\n",
    );
    expect(await pathExists(path.join(result.targetPath, "node_modules", "ignored.txt"))).toBe(
      false,
    );
  });

  it("moves a dirty worktree branch back to local and archives the old worktree", async () => {
    const repoPath = await createRepo();
    await git(repoPath, ["switch", "main"]);
    const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
    await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);
    await writeFile(path.join(worktreePath, "README.md"), "dirty worktree\n", "utf8");
    await writeFile(path.join(worktreePath, "worktree-note.txt"), "untracked\n", "utf8");

    const service = new GitWorkspaceHandoffService();
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
      repositoryPath: repoPath,
      sourcePath: worktreePath,
      sourceBranch: "feature/handoff",
      now: 2000,
    });

    expect(result.workMode).toBe("local");
    expect(result.linkedDirectory.kind).toBe("local");
    expect(result.archivedSourceWorktree).toMatchObject({
      state: "archived",
      worktreePath: await realpath(path.dirname(worktreePath)).then((root) =>
        path.join(root, path.basename(worktreePath)),
      ),
    });
    expect(await pathExists(worktreePath)).toBe(false);
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("feature/handoff");
    await expect(readFile(path.join(repoPath, "README.md"), "utf8")).resolves.toBe(
      "dirty worktree\n",
    );
    await expect(readFile(path.join(repoPath, "worktree-note.txt"), "utf8")).resolves.toBe(
      "untracked\n",
    );
  });

  it("protects dirty local changes separately when moving a worktree branch to local", async () => {
    const repoPath = await createRepo();
    await git(repoPath, ["switch", "main"]);
    await writeFile(path.join(repoPath, "local-only.txt"), "local dirty\n", "utf8");
    const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
    await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);

    const service = new GitWorkspaceHandoffService();
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
      repositoryPath: repoPath,
      sourcePath: worktreePath,
      sourceBranch: "feature/handoff",
      now: 3000,
    });

    expect(result.destinationStash).toMatchObject({
      applied: false,
      dropped: false,
    });
    expect(await pathExists(path.join(repoPath, "local-only.txt"))).toBe(false);
    expect(await git(repoPath, ["stash", "list"])).toContain("destination");
  });

  it("fails before stashing when the target branch is checked out in another worktree", async () => {
    const repoPath = await createRepo();
    await git(repoPath, ["switch", "main"]);
    const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
    await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);

    const service = new GitWorkspaceHandoffService();
    await expect(
      service.handoff({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
        repositoryPath: repoPath,
        sourcePath: repoPath,
        sourceBranch: "feature/handoff",
        leaveLocalBranch: "main",
        now: 4000,
      }),
    ).rejects.toThrow(/already checked out/);

    expect(await git(repoPath, ["stash", "list"])).toBe("");
  });
});
