import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitHandoffService } from "@pwragent/federation/git-instance-handoff";
import { expect, it } from "vitest";
import { runGitCommand } from "../app-server/git-executable";

// The bundled Git enables the LFS filter, and git-lfs installs its hooks
// wherever `core.hooksPath` points the first time the filter runs. A handoff
// that disabled hooks with a relative path left those hook scripts in the
// root of the imported worktree as untracked files.
it("imports an LFS checkout without writing hooks into the new worktree", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pwragent-handoff-lfs-")));
  const source = path.join(root, "source");
  const receiver = path.join(root, "receiver");
  const remote = path.join(root, "origin.git");
  const worktree = path.join(root, "imported", "receiver");
  // No operator LFS setup: the bundle's defaults alone enable the filter.
  const env = {
    ...process.env,
    PATH: process.platform === "win32" ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32") : "/usr/bin:/bin",
    GIT_CONFIG_GLOBAL: path.join(root, "empty-config"),
    GIT_LFS_SKIP_SMUDGE: "0",
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = async (cwd: string, args: string[]) => (await runGitCommand(cwd, args, { env })).stdout.trim();
  const handoff = createGitHandoffService((cwd, args, options) => runGitCommand(cwd, args, { ...options, env }));
  try {
    await mkdir(source);
    await writeFile(env.GIT_CONFIG_GLOBAL, "");
    await git(root, ["init", "--bare", "-b", "main", remote]);
    await git(source, ["init", "-b", "main"]);
    await git(source, ["config", "core.autocrlf", "false"]);
    await writeFile(path.join(source, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(path.join(source, "asset.bin"), Buffer.from("base\0binary\r\n"));
    await git(source, ["add", ".gitattributes", "asset.bin"]);
    await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "base"]);
    await git(source, ["remote", "add", "origin", remote]);
    // Skip the LFS pre-push hook; the fixture copies LFS objects directly
    // instead of running an LFS transfer.
    await git(source, ["push", "--no-verify", "origin", "main"]);
    await git(source, ["switch", "-c", "feature/lfs-handoff"]);
    const payload = Buffer.from("published feature\0binary\r\n");
    await writeFile(path.join(source, "asset.bin"), payload);
    await git(source, ["add", "asset.bin"]);
    await git(source, ["-c", "commit.gpgsign=false", "commit", "-m", "feature"]);
    await git(source, ["push", "--no-verify", "-u", "origin", "feature/lfs-handoff"]);

    await git(root, ["clone", "--no-checkout", "--config", "core.autocrlf=false", remote, receiver]);
    await cp(path.join(source, ".git", "lfs", "objects"), path.join(receiver, ".git", "lfs", "objects"), { recursive: true });
    await git(receiver, ["checkout", "main"]);
    expect(await git(receiver, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

    const snapshot = await handoff.exportGitHandoff(source);
    expect(snapshot.sourceBranch).toBe("feature/lfs-handoff");
    const rollback = await handoff.importGitHandoff({ repository: receiver, worktree, snapshot });
    expect(rollback).toBeTypeOf("function");

    // The filter ran during checkout and the transactional branch switch.
    expect(await readFile(path.join(worktree, "asset.bin"))).toEqual(payload);
    expect(await git(worktree, ["branch", "--show-current"])).toBe("feature/lfs-handoff");
    expect(await git(worktree, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
    expect((await readdir(worktree)).sort()).toEqual([".git", ".gitattributes", "asset.bin"]);
    // The fetch runs in the receiving checkout; it must stay clean too.
    expect(await git(receiver, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  // About 25 Git processes, several of them running the LFS filter: 3.8s on
  // a macOS runner, close to the 5s default.
}, 20_000);
