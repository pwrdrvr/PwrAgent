import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noteBundledGitCommand, setBundledGitLfsAdvisory } from "../bundled-git-lfs-advisory";
import { bundledGitExecutable } from "../bundled-git";
import { setGitCommandResolver } from "../git-command";

/** What git-lfs writes, down to the test that fails the operator's push. */
const LFS_PRE_PUSH_HOOK = [
  "#!/bin/sh",
  "command -v git-lfs >/dev/null 2>&1 || {",
  '  printf >&2 "%s\\n" "This repository is configured for Git LFS but \'git-lfs\' was not found on your path.";',
  "  exit 2",
  "}",
  'git lfs pre-push "$@"',
].join("\n");

const roots: string[] = [];

/**
 * A checkout with Git LFS hooks, a linked worktree of it, and a bin directory
 * that may or may not hold the operator's own git-lfs.
 */
function fixture(options: { hook?: string; installedLfs?: boolean } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "pwragent-lfs-advisory-"));
  roots.push(root);
  const repository = path.join(root, "repo");
  const gitDir = path.join(repository, ".git");
  mkdirSync(path.join(gitDir, "hooks"), { recursive: true });
  mkdirSync(path.join(gitDir, "worktrees", "feature"), { recursive: true });
  mkdirSync(path.join(repository, "src"), { recursive: true });
  const worktree = path.join(root, "feature");
  mkdirSync(worktree);
  writeFileSync(
    path.join(worktree, ".git"),
    `gitdir: ${path.join(gitDir, "worktrees", "feature")}\n`,
  );
  const hook = options.hook ?? LFS_PRE_PUSH_HOOK;
  if (hook) writeFileSync(path.join(gitDir, "hooks", "pre-push"), hook);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  if (options.installedLfs) {
    writeFileSync(
      path.join(bin, process.platform === "win32" ? "git-lfs.exe" : "git-lfs"),
      "",
    );
  }
  return { bin, env: { PATH: bin } as NodeJS.ProcessEnv, repository, root, worktree };
}

afterEach(() => {
  setBundledGitLfsAdvisory(undefined);
  setGitCommandResolver(undefined);
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("bundled Git LFS advisory", () => {
  it("reports the checkout a linked worktree shares its hooks with", () => {
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    const repo = fixture();
    // Deep inside the worktree: the hooks live in the common directory.
    noteBundledGitCommand(repo.worktree, ["checkout", "--", "asset.bin"], repo.env);
    expect(advise).toHaveBeenCalledExactlyOnceWith(repo.repository);

    // Once per working directory, however many commands run there.
    noteBundledGitCommand(repo.worktree, ["commit", "-m", "x"], repo.env);
    expect(advise).toHaveBeenCalledTimes(1);

    // A nested directory of the same repository is its own entry.
    noteBundledGitCommand(path.join(repo.repository, "src"), ["add", "-A"], repo.env);
    expect(advise).toHaveBeenCalledTimes(2);
    expect(advise).toHaveBeenLastCalledWith(repo.repository);
  });

  it("stays silent when the operator has their own git-lfs", () => {
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    const repo = fixture({ installedLfs: true });
    noteBundledGitCommand(repo.repository, ["checkout", "main"], repo.env);
    expect(advise).not.toHaveBeenCalled();
  });

  it("stays silent for a repository with no Git LFS hooks", () => {
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    const withoutHook = fixture({ hook: "" });
    noteBundledGitCommand(withoutHook.repository, ["checkout", "main"], withoutHook.env);
    // A pre-push hook that is not Git LFS is somebody else's.
    const otherHook = fixture({ hook: "#!/bin/sh\nexec ./scripts/verify.sh\n" });
    noteBundledGitCommand(otherHook.repository, ["checkout", "main"], otherHook.env);
    expect(advise).not.toHaveBeenCalled();
  });

  it("stays silent for a selected Git, which carries the operator's own setup", () => {
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    const repo = fixture();
    setGitCommandResolver(() => bundledGitExecutable());
    noteBundledGitCommand(repo.repository, ["checkout", "main"], repo.env);
    expect(advise).not.toHaveBeenCalled();

    setGitCommandResolver(undefined);
    noteBundledGitCommand(repo.worktree, ["checkout", "main"], repo.env);
    expect(advise).toHaveBeenCalledExactlyOnceWith(repo.repository);
  });

  it("checks only after a command that can install the hooks", () => {
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    const repo = fixture();
    // Status and log run on every poll; they never run the LFS filter.
    noteBundledGitCommand(repo.repository, ["status", "--porcelain"], repo.env);
    noteBundledGitCommand(repo.repository, ["log", "-1", "--format=%H"], repo.env);
    expect(advise).not.toHaveBeenCalled();
    noteBundledGitCommand(repo.repository, ["worktree", "add", "../feature"], repo.env);
    expect(advise).toHaveBeenCalledExactlyOnceWith(repo.repository);
  });

  it("does nothing at all without a publisher", () => {
    const repo = fixture();
    expect(() => noteBundledGitCommand(repo.repository, ["checkout"], repo.env)).not.toThrow();
    const advise = vi.fn();
    setBundledGitLfsAdvisory(advise);
    // Installing a publisher clears what earlier commands recorded, so a
    // repository seen before any window subscribed is still reported.
    noteBundledGitCommand(repo.repository, ["checkout"], repo.env);
    expect(advise).toHaveBeenCalledExactlyOnceWith(repo.repository);
  });
});
