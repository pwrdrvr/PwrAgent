import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitDirectoryService } from "../app-server/git-directory-service";
import { runGitCommand } from "../app-server/git-executable";

describe("worktree creation with bundled Git LFS", () => {
  it.each(["detached", "attached"] as const)("hydrates LFS content in a new %s worktree and rolls it back", async (worktreeBranchMode) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-lfs-")));
    const repo = path.join(root, "repo");
    const remote = path.join(root, "origin.git");
    // The operator has no LFS setup: an empty global config, and no
    // `git lfs install` in the repository. The bundle's defaults are all
    // that enable the filter.
    const env = {
      ...process.env,
      PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
      GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
      GIT_LFS_SKIP_SMUDGE: "0",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    };
    const git = async (cwd: string, args: string[]) => (await runGitCommand(cwd, args, { env })).stdout.trim();
    try {
      await mkdir(repo);
      await writeFile(env.GIT_CONFIG_GLOBAL, "");
      await git(repo, ["init", "-b", "main"]);
      await writeFile(path.join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
      const payload = Buffer.from("LFS worktree fixture\0binary content\r\n");
      await writeFile(path.join(repo, "asset.bin"), payload);
      await git(repo, ["add", ".gitattributes", "asset.bin"]);
      await git(repo, ["-c", "commit.gpgsign=false", "commit", "-m", "LFS fixture"]);
      const head = await git(repo, ["rev-parse", "HEAD"]);
      const pointer = await git(repo, ["show", "HEAD:asset.bin"]);
      expect(pointer).toMatch(/^version https:\/\/git-lfs.github.com\/spec\/v1\n/);

      // Publish the base ref locally. LFS objects remain in the source repo's
      // shared storage; this fixture needs no network or external LFS server.
      await git(repo, ["clone", "--bare", repo, remote]);
      await git(repo, ["remote", "add", "origin", remote]);
      await git(repo, ["fetch", "origin"]);
      const service = new GitDirectoryService({
        gitEnv: env,
        homeDir: path.join(root, "home"),
        resolveWorktreeStorage: () => "user-home",
      });
      // Use the production runner, path allocator and worktree transaction.
      const workspace = await service.prepareLaunchpadWorkspace({
        directoryKind: "directory", directoryLabel: "LFS fixture",
        directoryPath: repo, branchName: "main", workMode: "worktree",
        worktreeBranchMode,
      });
      expect(workspace.workMode).toBe("worktree");
      expect(workspace.cwd).toBeDefined();
      expect(await realpath(workspace.cwd!)).not.toBe(repo);
      expect(await readFile(path.join(workspace.cwd!, "asset.bin"))).toEqual(payload);
      expect(await git(workspace.cwd!, ["show", "HEAD:asset.bin"])).toBe(pointer);
      expect(await git(workspace.cwd!, ["status", "--porcelain"])).toBe("");
      expect(await git(workspace.cwd!, ["branch", "--show-current"]))
        .toBe(worktreeBranchMode === "attached" ? "main" : "");
      expect(await git(workspace.cwd!, ["rev-parse", "HEAD"])).toBe(head);

      expect(workspace.rollback).toBeTypeOf("function");
      await workspace.rollback!();
      await expect(readFile(path.join(workspace.cwd!, "asset.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await git(repo, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(1);
      expect(await git(repo, ["branch", "--show-current"])).toBe("main");
      expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
      expect(await readFile(path.join(repo, "asset.bin"))).toEqual(payload);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
