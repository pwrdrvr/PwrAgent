import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDirectory } from "@pwragent/shared";
import { GitWorkspaceHandoffService } from "../app-server/git-workspace-handoff-service";
import type { WorktreeArchiveService } from "../app-server/worktree-archive-service";

const execFileAsync = promisify(execFile);
const cleanupPaths: string[] = [];

// The handoff service forward-slashes the directory/worktree identifiers it
// returns (no-op on POSIX; on Windows `C:\…` becomes `C:/…`). Expected path
// strings derived from native temp dirs must be normalized the same way so the
// comparisons hold on both platforms.
function toForwardSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-"));
  cleanupPaths.push(root);
  const repoPath = path.join(root, "PwrAgent");
  await mkdir(repoPath);
  await git(repoPath, ["init", "-b", "main"]);
  // On Windows git defaults to autocrlf=true, which rewrites committed/restored
  // file content to CRLF. Force LF so the `\n` expectations below hold on every
  // platform (no-op on POSIX where these are already the effective defaults).
  await git(repoPath, ["config", "core.autocrlf", "false"]);
  await git(repoPath, ["config", "core.eol", "lf"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "Test User"]);
  await writeFile(path.join(repoPath, "README.md"), "main\n", "utf8");
  await writeFile(path.join(repoPath, ".gitignore"), "node_modules/\n.worktrees/\n", "utf8");
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
    cleanupPaths.splice(0).map((target) =>
      rm(target, { recursive: true, force: true }),
    ),
  );
});

describe("GitWorkspaceHandoffService", () => {
  it("keeps a worktree thread isolated when moving to another project's checkout", async () => {
    const source = await createRepo();
    const sourceWorktree = path.join(source, ".worktrees", "source");
    await git(source, ["worktree", "add", "--detach", sourceWorktree, "HEAD"]);
    const target = await createRepo();
    await writeFile(path.join(sourceWorktree, "notes.txt"), "source changes");
    await writeFile(path.join(target, "README.md"), "destination changes");
    const targetHead = await git(target, ["rev-parse", "HEAD"]);
    const result = await new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    }).handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project",
      sourcePath: sourceWorktree, sourceWorkMode: "worktree", targetPath: target, now: 1000,
    });
    expect(result.workMode).toBe("worktree");
    expect(result.targetPath).not.toBe(toForwardSlashes(await realpath(target)));
    expect(result.linkedDirectory).toMatchObject({
      path: toForwardSlashes(await realpath(target)), worktreePath: result.targetPath,
    });
    expect(result.linkedDirectory.worktreeOwnership).toBeUndefined();
    expect(result.branch).toBe("HEAD");
    expect(await git(result.targetPath, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(await git(target, ["branch", "--show-current"])).toBe("feature/handoff");
    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("destination changes");
    expect(await readFile(path.join(sourceWorktree, "notes.txt"), "utf8")).toBe("source changes");
    expect(result.archivedSourceWorktree).toBeUndefined();
  });

  it("reuses the thread's destination worktree when a project root is selected", async () => {
    const target = await createRepo();
    const worktreePath = path.join(target, ".worktrees", "existing");
    await git(target, ["worktree", "add", "-b", "feature/existing", worktreePath, "HEAD"]);
    await writeFile(path.join(worktreePath, "notes.txt"), "ongoing work");
    const before = await git(target, ["worktree", "list", "--porcelain"]);
    const result = await new GitWorkspaceHandoffService().handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: target,
      workspacePaths: [worktreePath],
    });
    expect(result).toMatchObject({
      workMode: "worktree", branch: "feature/existing",
      targetPath: toForwardSlashes(await realpath(worktreePath)),
      linkedDirectory: { worktreeOwnership: "external" },
    });
    expect(await git(target, ["worktree", "list", "--porcelain"])).toBe(before);
    expect(await readFile(path.join(worktreePath, "notes.txt"), "utf8")).toBe("ongoing work");
  });

  it.each(["project-root", "worktree-root"])("preserves managed ownership across repeated project moves: %s", async (target) => {
    const repo = await createRepo();
    const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
    const created = await service.handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: repo,
      sourceWorkMode: "worktree", now: 1000,
    });
    await writeFile(path.join(created.targetPath, "notes.txt"), "ongoing managed work");
    const before = await git(repo, ["worktree", "list", "--porcelain"]);
    const reused = await service.handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project",
      targetPath: target === "project-root" ? repo : created.targetPath,
      sourceWorkMode: "worktree", workspacePaths: [created.targetPath],
      workspaceDirectories: [created.linkedDirectory],
    });
    expect(reused.targetPath).toBe(created.targetPath);
    expect(reused.linkedDirectory.worktreeOwnership).toBeUndefined();
    expect(await git(repo, ["worktree", "list", "--porcelain"])).toBe(before);
    expect(await readFile(path.join(reused.targetPath, "notes.txt"), "utf8")).toBe("ongoing managed work");
  });

  it.each([false, true])("keeps persisted external ownership when reusing a worktree, even with a conflicting alias: %s", async (conflictingAlias) => {
    const repo = await createRepo();
    const worktreePath = path.join(repo, ".worktrees", "external");
    await git(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    const directory = { id: "external", label: "target", path: repo, kind: "worktree" as const, worktreePath };
    const result = await new GitWorkspaceHandoffService().handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: repo,
      workspacePaths: [worktreePath], workspaceDirectories: [
        { ...directory, worktreeOwnership: "external" },
        ...(conflictingAlias ? [{ ...directory, id: "alias" }] : []),
      ],
    });
    expect(result.targetPath).toBe(toForwardSlashes(await realpath(worktreePath)));
    expect(result.linkedDirectory.worktreeOwnership).toBe("external");
  });

  it("moves a scratch thread to another project without touching either checkout", async () => {
    const source = await createRepo();
    const target = await createRepo();
    await writeFile(path.join(source, "notes.txt"), "source changes");
    await writeFile(path.join(target, "README.md"), "destination changes");
    const before = await Promise.all([git(source, ["status", "--porcelain"]), git(target, ["status", "--porcelain"])]);
    const service = new GitWorkspaceHandoffService();
    const result = await service.handoff({
      backend: "acp:grok",
      threadId: "existing-conversation",
      direction: "to-project",
      targetPath: target,
      now: 1000,
    });
    expect(result).toMatchObject({
      threadId: "existing-conversation",
      direction: "to-project",
      workMode: "local",
      targetPath: toForwardSlashes(await realpath(target)),
      branch: "feature/handoff",
    });
    expect(result.archivedSourceWorktree).toBeUndefined();
    expect(await Promise.all([git(source, ["status", "--porcelain"]), git(target, ["status", "--porcelain"])])).toEqual(before);
    expect(await readFile(path.join(source, "notes.txt"), "utf8")).toBe("source changes");
    expect(await readFile(path.join(target, "README.md"), "utf8")).toBe("destination changes");
  });

  it("resolves an existing destination worktree without creating or archiving one", async () => {
    const repo = await createRepo();
    const target = path.join(repo, ".worktrees", "destination");
    await git(repo, ["worktree", "add", "--detach", target, "HEAD"]);
    const result = await new GitWorkspaceHandoffService().handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: target,
    });
    expect(result.linkedDirectory).toMatchObject({
      path: toForwardSlashes(await realpath(repo)),
      worktreePath: toForwardSlashes(await realpath(target)),
      kind: "worktree",
    });
    expect(result.branch).toBe("HEAD");
  });

  it("requires an explicit worktree when the thread has multiple destination worktrees", async () => {
    const repo = await createRepo();
    const paths = ["first", "second"].map((name) => path.join(repo, ".worktrees", name));
    for (const worktreePath of paths) await git(repo, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    const service = new GitWorkspaceHandoffService();
    await expect(service.handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: repo, workspacePaths: paths,
    })).rejects.toThrow("multiple worktrees");
    const result = await service.handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: paths[1], workspacePaths: paths,
    });
    expect(result.targetPath).toBe(toForwardSlashes(await realpath(paths[1]!)));
  });

  it("does not reuse a linked worktree from another repository", async () => {
    const source = await createRepo();
    const worktreePath = path.join(source, ".worktrees", "source");
    await git(source, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    const target = await createRepo();
    const result = await new GitWorkspaceHandoffService().handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: target,
      workspacePaths: [worktreePath],
    });
    expect(result.targetPath).toBe(toForwardSlashes(await realpath(target)));
    expect(result.workMode).toBe("local");
  });

  it("rejects missing, non-Git, and non-root destination directories", async () => {
    const repo = await createRepo();
    const service = new GitWorkspaceHandoffService();
    const move = (targetPath?: string) => service.handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath,
    });
    await expect(move()).rejects.toThrow("absolute");
    await expect(move("relative")).rejects.toThrow("absolute");
    await expect(move(path.join(repo, "missing"))).rejects.toThrow();
    await expect(move(path.dirname(repo))).rejects.toThrow("Git project");
    await expect(move(path.join(repo, "README.md"))).rejects.toThrow("existing directory");
    await expect(move(path.join(repo, ".git"))).rejects.toThrow("Git project");
    await mkdir(path.join(repo, "subdir"));
    await expect(move(path.join(repo, "subdir"))).rejects.toThrow("root");
  });

  it("adopts an external Claude worktree under its Git parent project without changing files or branches", async () => {
    const repo = await createRepo();
    const target = path.join(path.dirname(repo), "claude-worktrees", "PwrAgent", "interesting-poitras");
    await git(repo, ["worktree", "add", "-b", "claude/feature", target, "HEAD"]);
    await writeFile(path.join(target, "README.md"), "uncommitted edits\n");
    await writeFile(path.join(target, "notes.txt"), "untracked notes\n");
    const before = await Promise.all([
      git(target, ["status", "--porcelain"]),
      git(repo, ["worktree", "list", "--porcelain"]),
    ]);
    const result = await new GitWorkspaceHandoffService().handoff({
      backend: "codex", threadId: "thread-1", direction: "to-project", targetPath: target,
    });
    const repositoryPath = toForwardSlashes(await realpath(repo));
    expect(result).toMatchObject({
      targetPath: toForwardSlashes(await realpath(target)),
      repositoryPath,
      branch: "claude/feature",
      workMode: "worktree",
      linkedDirectory: {
        label: "PwrAgent", path: repositoryPath,
        worktreePath: toForwardSlashes(await realpath(target)),
        worktreeOwnership: "external",
      },
    });
    expect(classifyDirectory(result.linkedDirectory)).toMatchObject({
      key: `directory:${repositoryPath}`, label: "PwrAgent", path: repositoryPath,
    });
    expect(result.archivedSourceWorktree).toBeUndefined();
    expect(await Promise.all([
      git(target, ["status", "--porcelain"]),
      git(repo, ["worktree", "list", "--porcelain"]),
    ])).toEqual(before);
  });

  it("moves a dirty local branch to a new worktree and leaves local on the selected branch", async () => {
    const repoPath = await createRepo();
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");
    await writeFile(path.join(repoPath, "notes.txt"), "untracked\n", "utf8");
    await mkdir(path.join(repoPath, "node_modules"));
    await writeFile(path.join(repoPath, "node_modules", "ignored.txt"), "ignored\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
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
    expect(path.basename(result.targetPath)).toBe("PwrAgent");
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

  it("moves a dirty local branch to a new worktree and leaves local detached", async () => {
    const repoPath = await createRepo();
    const headSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      leaveLocalBranch: "HEAD",
      now: 1250,
    });

    expect(result.workMode).toBe("worktree");
    expect(result.branch).toBe("feature/handoff");
    expect(result.warnings).toContain(
      "Local was left on a detached HEAD at the moved branch commit.",
    );
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("");
    expect(await git(repoPath, ["rev-parse", "HEAD"])).toBe(headSha);
    expect(await git(result.targetPath, ["branch", "--show-current"])).toBe(
      "feature/handoff",
    );
    await expect(readFile(path.join(result.targetPath, "README.md"), "utf8")).resolves.toBe(
      "dirty local\n",
    );
  });

  it("moves dirty local changes to a detached worktree and leaves local on the current branch", async () => {
    const repoPath = await createRepo();
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");
    await writeFile(path.join(repoPath, "notes.txt"), "untracked\n", "utf8");
    await mkdir(path.join(repoPath, "node_modules"));
    await writeFile(path.join(repoPath, "node_modules", "ignored.txt"), "ignored\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      strategy: "detached-changes",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      now: 1500,
    });

    expect(result.workMode).toBe("worktree");
    expect(result.strategy).toBe("detached-changes");
    expect(result.branch).toBeUndefined();
    expect(result.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.linkedDirectory.kind).toBe("worktree");
    expect(path.basename(result.targetPath)).toBe("PwrAgent");
    expect(result.sourceStash).toMatchObject({ applied: true, dropped: true });
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("feature/handoff");
    expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("");
    expect(await git(result.targetPath, ["rev-parse", "HEAD"])).toBe(result.baseSha);
    await expect(readFile(path.join(result.targetPath, "feature.txt"), "utf8")).resolves.toBe(
      "feature\n",
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
    expect(await git(repoPath, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
  });

  it("moves dirty local changes to a new branch worktree and leaves local on the current branch", async () => {
    const repoPath = await createRepo();
    const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");
    await writeFile(path.join(repoPath, "notes.txt"), "untracked\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      strategy: "new-branch",
      newBranchName: "pwragent/feature-handoff",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      now: 1750,
    });

    expect(result.workMode).toBe("worktree");
    expect(result.strategy).toBe("new-branch");
    expect(result.branch).toBe("pwragent/feature-handoff");
    expect(result.baseSha).toBe(baseSha);
    expect(result.sourceStash).toMatchObject({ applied: true, dropped: true });
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("feature/handoff");
    expect(await git(result.targetPath, ["branch", "--show-current"])).toBe(
      "pwragent/feature-handoff",
    );
    expect(await git(result.targetPath, ["rev-parse", "HEAD"])).toBe(baseSha);
    await expect(readFile(path.join(result.targetPath, "README.md"), "utf8")).resolves.toBe(
      "dirty local\n",
    );
    await expect(readFile(path.join(result.targetPath, "notes.txt"), "utf8")).resolves.toBe(
      "untracked\n",
    );
    expect(await git(repoPath, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
  });

  it("preserves a valid requested new branch name without sanitizing it", async () => {
    const repoPath = await createRepo();
    const requestedBranchName = "feature/foo+bar";
    await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      strategy: "new-branch",
      newBranchName: ` ${requestedBranchName} `,
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      now: 1775,
    });

    expect(result.branch).toBe(requestedBranchName);
    expect(await git(result.targetPath, ["branch", "--show-current"])).toBe(
      requestedBranchName,
    );
    expect(await git(repoPath, ["show-ref", "--verify", `refs/heads/${requestedBranchName}`]))
      .toMatch(/refs\/heads\/feature\/foo\+bar$/);
  });

  it("rejects new branch handoff when the requested branch already exists", async () => {
    const repoPath = await createRepo();

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    await expect(
      service.handoff({
        backend: "codex",
        threadId: "thread-1",
        direction: "local-to-worktree",
        strategy: "new-branch",
        newBranchName: "main",
        repositoryPath: repoPath,
        sourcePath: repoPath,
        sourceBranch: "feature/handoff",
        now: 1800,
      }),
    ).rejects.toThrow(/already exists/);

    expect(await git(repoPath, ["stash", "list"])).toBe("");
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
        toForwardSlashes(path.join(root, path.basename(worktreePath))),
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

  describe("worktree to new worktree", () => {
    async function dirtyWorktree(): Promise<{ repoPath: string; worktreePath: string }> {
      const repoPath = await createRepo();
      await git(repoPath, ["switch", "main"]);
      const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
      await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);
      await writeFile(path.join(worktreePath, "README.md"), "dirty worktree\n", "utf8");
      await writeFile(path.join(worktreePath, "worktree-note.txt"), "untracked\n", "utf8");
      return { repoPath, worktreePath };
    }

    async function expectCarriedChanges(targetPath: string): Promise<void> {
      await expect(readFile(path.join(targetPath, "README.md"), "utf8")).resolves.toBe("dirty worktree\n");
      await expect(readFile(path.join(targetPath, "worktree-note.txt"), "utf8")).resolves.toBe("untracked\n");
    }

    it("moves the branch and its changes to a new worktree and archives the old one", async () => {
      const { repoPath, worktreePath } = await dirtyWorktree();
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const result = await service.handoff({
        backend: "claude", threadId: "thread-1", direction: "worktree-to-worktree", strategy: "move-branch",
        repositoryPath: repoPath, sourcePath: worktreePath, sourceBranch: "feature/handoff", now: 3000,
      });

      expect(result).toMatchObject({ direction: "worktree-to-worktree", strategy: "move-branch", workMode: "worktree", branch: "feature/handoff" });
      expect(result.linkedDirectory).toMatchObject({ kind: "worktree", worktreePath: toForwardSlashes(result.targetPath) });
      expect(path.resolve(result.targetPath)).not.toBe(path.resolve(worktreePath));
      expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("feature/handoff");
      await expectCarriedChanges(result.targetPath);
      expect(result.archivedSourceWorktree).toMatchObject({ state: "archived" });
      expect(await pathExists(worktreePath)).toBe(false);
      // Local was never involved.
      expect(await git(repoPath, ["branch", "--show-current"])).toBe("main");
    });

    it("starts a new branch from the worktree's commit and keeps the old branch", async () => {
      const { repoPath, worktreePath } = await dirtyWorktree();
      const baseSha = await git(worktreePath, ["rev-parse", "HEAD"]);
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const result = await service.handoff({
        backend: "claude", threadId: "thread-1", direction: "worktree-to-worktree", strategy: "new-branch",
        newBranchName: "feature/next", repositoryPath: repoPath, sourcePath: worktreePath, now: 3100,
      });

      expect(result).toMatchObject({ direction: "worktree-to-worktree", strategy: "new-branch", branch: "feature/next", baseSha });
      expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("feature/next");
      await expectCarriedChanges(result.targetPath);
      expect(await pathExists(worktreePath)).toBe(false);
      expect(await git(repoPath, ["rev-parse", "feature/handoff"])).toBe(baseSha);
    });

    it("leaves a worktree the thread does not own on disk", async () => {
      const { repoPath, worktreePath } = await dirtyWorktree();
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const result = await service.handoff({
        backend: "codex", threadId: "thread-1", direction: "worktree-to-worktree",
        repositoryPath: repoPath, sourcePath: worktreePath, keepSourceWorktree: true, now: 3200,
      });

      expect(result.strategy).toBe("detached-changes");
      expect(await git(result.targetPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      await expectCarriedChanges(result.targetPath);
      expect(result.archivedSourceWorktree).toBeUndefined();
      expect(result.warnings).toContain("The previous worktree was created outside PwrAgent, so it was left on disk.");
      expect(await pathExists(worktreePath)).toBe(true);
      expect(await git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
    });

    it("refuses to start from the local checkout", async () => {
      const repoPath = await createRepo();
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      await expect(service.handoff({
        backend: "claude", threadId: "thread-1", direction: "worktree-to-worktree",
        repositoryPath: repoPath, sourcePath: repoPath,
      })).rejects.toThrow("Worktree-to-worktree handoff must start from a worktree.");
    });
  });

  describe("fresh worktree from a base ref", () => {
    it("starts a detached worktree at the base and leaves the dirty local checkout alone", async () => {
      const repoPath = await createRepo();
      await writeFile(path.join(repoPath, "README.md"), "dirty local\n", "utf8");
      const mainSha = await git(repoPath, ["rev-parse", "main"]);
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const result = await service.handoff({
        backend: "claude", threadId: "thread-1", direction: "local-to-worktree", baseRef: "main",
        repositoryPath: repoPath, sourcePath: repoPath, now: 4000,
      });

      expect(result).toMatchObject({ direction: "local-to-worktree", strategy: "detached-changes", workMode: "worktree", baseSha: mainSha });
      expect(result.branch).toBeUndefined();
      expect(await git(result.targetPath, ["rev-parse", "HEAD"])).toBe(mainSha);
      expect(await git(result.targetPath, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      expect(await git(result.targetPath, ["status", "--porcelain", "--untracked-files=normal"])).toBe("");
      expect(await pathExists(path.join(result.targetPath, "feature.txt"))).toBe(false);
      expect(result.sourceStash).toBeUndefined();
      expect(result.warnings[0]).toBe("The new worktree starts at main.");
      expect(result.warnings[1]).toMatch(/^Uncommitted changes stayed in .+PwrAgent\.$/);
      // Local is not a worktree: nothing is said about archiving it.
      expect(result.warnings).toHaveLength(2);
      // Local kept its branch and its changes.
      expect(await git(repoPath, ["branch", "--show-current"])).toBe("feature/handoff");
      await expect(readFile(path.join(repoPath, "README.md"), "utf8")).resolves.toBe("dirty local\n");
    });

    it("starts a new branch at the base and leaves the old worktree on disk", async () => {
      const repoPath = await createRepo();
      await git(repoPath, ["switch", "main"]);
      const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
      await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);
      await writeFile(path.join(worktreePath, "worktree-note.txt"), "untracked\n", "utf8");
      const mainSha = await git(repoPath, ["rev-parse", "main"]);
      const archive = vi.fn();
      const service = new GitWorkspaceHandoffService({
        resolveWorktreeStorage: () => "in-repo",
        worktreeArchiveService: { archive } as unknown as WorktreeArchiveService,
      });
      const result = await service.handoff({
        backend: "codex", threadId: "thread-1", direction: "worktree-to-worktree", strategy: "new-branch",
        newBranchName: "feature/fresh", baseRef: "main", repositoryPath: repoPath, sourcePath: worktreePath, now: 4100,
      });

      expect(result).toMatchObject({ direction: "worktree-to-worktree", strategy: "new-branch", branch: "feature/fresh", baseSha: mainSha });
      expect(await git(result.targetPath, ["branch", "--show-current"])).toBe("feature/fresh");
      expect(await pathExists(path.join(result.targetPath, "worktree-note.txt"))).toBe(false);
      expect(archive).not.toHaveBeenCalled();
      expect(result.archivedSourceWorktree).toBeUndefined();
      // The thread owns this worktree, so archiving the thread cleans it up later.
      expect(result.warnings.at(-1)).toBe("The previous worktree stays on disk. Archiving this thread checkpoints and removes it.");
      expect(await pathExists(worktreePath)).toBe(true);
      expect(await git(worktreePath, ["branch", "--show-current"])).toBe("feature/handoff");
      await expect(readFile(path.join(worktreePath, "worktree-note.txt"), "utf8")).resolves.toBe("untracked\n");
    });

    it("promises no archive cleanup for a Claude thread, whose archive keeps worktrees", async () => {
      const repoPath = await createRepo();
      await git(repoPath, ["switch", "main"]);
      const worktreePath = path.join(path.dirname(repoPath), "worktree-claude");
      await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      const result = await service.handoff({
        backend: "claude", threadId: "thread-1", direction: "worktree-to-worktree", baseRef: "main",
        repositoryPath: repoPath, sourcePath: worktreePath, now: 4120,
      });

      expect(result.warnings.at(-1)).toBe("The previous worktree stays on disk.");
      expect(await pathExists(worktreePath)).toBe(true);
    });

    it("says an adopted worktree is left on disk and never archives it", async () => {
      const repoPath = await createRepo();
      await git(repoPath, ["switch", "main"]);
      const worktreePath = path.join(path.dirname(repoPath), "worktree-adopted");
      await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);
      await writeFile(path.join(worktreePath, "README.md"), "another agent's edit\n", "utf8");
      const archive = vi.fn();
      const service = new GitWorkspaceHandoffService({
        resolveWorktreeStorage: () => "in-repo",
        worktreeArchiveService: { archive } as unknown as WorktreeArchiveService,
      });
      const result = await service.handoff({
        backend: "codex", threadId: "thread-1", direction: "worktree-to-worktree", baseRef: "main",
        repositoryPath: repoPath, sourcePath: worktreePath, keepSourceWorktree: true, now: 4150,
      });

      expect(archive).not.toHaveBeenCalled();
      expect(result.warnings).toContain("The previous worktree was created outside PwrAgent, so it was left on disk.");
      expect(result.warnings.join("\n")).not.toMatch(/Archiving this thread/);
      await expect(readFile(path.join(worktreePath, "README.md"), "utf8")).resolves.toBe("another agent's edit\n");
      expect(await git(worktreePath, ["branch", "--show-current"])).toBe("feature/handoff");
    });

    it("rejects a base ref that does not resolve and creates nothing", async () => {
      const repoPath = await createRepo();
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      await expect(service.handoff({
        backend: "claude", threadId: "thread-1", direction: "local-to-worktree", baseRef: "origin/missing",
        repositoryPath: repoPath, sourcePath: repoPath, now: 4200,
      })).rejects.toThrow("Base branch origin/missing was not found in this repository.");
      expect(await git(repoPath, ["worktree", "list", "--porcelain"])).not.toContain(".worktrees");
    });

    it("rejects moving the current branch or returning to local", async () => {
      const repoPath = await createRepo();
      const service = new GitWorkspaceHandoffService({ resolveWorktreeStorage: () => "in-repo" });
      await expect(service.handoff({
        backend: "claude", threadId: "thread-1", direction: "local-to-worktree", strategy: "move-branch",
        baseRef: "main", repositoryPath: repoPath, sourcePath: repoPath,
      })).rejects.toThrow("Moving the current branch cannot start from a base branch.");
      await expect(service.handoff({
        backend: "claude", threadId: "thread-1", direction: "worktree-to-local",
        baseRef: "main", repositoryPath: repoPath, sourcePath: repoPath,
      })).rejects.toThrow("A base branch applies only to a handoff into a new worktree.");
    });
  });

  it("moves a detached worktree head back to local without treating stale branch metadata as truth", async () => {
    const repoPath = await createRepo();
    await writeFile(path.join(repoPath, "README.md"), "dirty detached\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const detachedResult = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      strategy: "detached-changes",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      now: 2500,
    });

    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "worktree-to-local",
      repositoryPath: repoPath,
      sourcePath: detachedResult.targetPath,
      sourceBranch: "main",
      now: 2600,
    });

    expect(result.workMode).toBe("local");
    expect(result.strategy).toBe("detached-changes");
    expect(result.branch).toBeUndefined();
    expect(result.baseSha).toBe(detachedResult.baseSha);
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("");
    expect(await git(repoPath, ["rev-parse", "HEAD"])).toBe(detachedResult.baseSha);
    await expect(readFile(path.join(repoPath, "README.md"), "utf8")).resolves.toBe(
      "dirty detached\n",
    );
    expect(await pathExists(detachedResult.targetPath)).toBe(false);
  });

  it("allows detached-changes handoff from a detached HEAD", async () => {
    const repoPath = await createRepo();
    await git(repoPath, ["checkout", "--detach"]);
    await writeFile(path.join(repoPath, "scratch.txt"), "scratch\n", "utf8");

    const service = new GitWorkspaceHandoffService({
      resolveWorktreeStorage: () => "in-repo",
    });
    const result = await service.handoff({
      backend: "codex",
      threadId: "thread-1",
      direction: "local-to-worktree",
      strategy: "detached-changes",
      repositoryPath: repoPath,
      sourcePath: repoPath,
      sourceBranch: "feature/handoff",
      now: 5000,
    });

    expect(result.workMode).toBe("worktree");
    expect(result.strategy).toBe("detached-changes");
    expect(path.basename(result.targetPath)).toBe("PwrAgent");
    await expect(readFile(path.join(result.targetPath, "scratch.txt"), "utf8")).resolves.toBe(
      "scratch\n",
    );
  });

  it("rejects moving a worktree branch to local when local has dirty changes", async () => {
    const repoPath = await createRepo();
    await git(repoPath, ["switch", "main"]);
    await writeFile(path.join(repoPath, "local-only.txt"), "local dirty\n", "utf8");
    const worktreePath = path.join(path.dirname(repoPath), "worktree-feature");
    await git(repoPath, ["worktree", "add", worktreePath, "feature/handoff"]);

    const service = new GitWorkspaceHandoffService();
    await expect(
      service.handoff({
        backend: "codex",
        threadId: "thread-1",
        direction: "worktree-to-local",
        repositoryPath: repoPath,
        sourcePath: worktreePath,
        sourceBranch: "feature/handoff",
        now: 3000,
      }),
    ).rejects.toThrow(/Local has dirty tracked or untracked changes/);

    expect(await pathExists(worktreePath)).toBe(true);
    expect(await pathExists(path.join(repoPath, "local-only.txt"))).toBe(true);
    expect(await git(repoPath, ["branch", "--show-current"])).toBe("main");
    expect(await git(worktreePath, ["branch", "--show-current"])).toBe(
      "feature/handoff",
    );
    expect(await git(repoPath, ["stash", "list"])).toBe("");
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
