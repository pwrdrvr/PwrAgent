import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { probeCurrentGitBranch } from "../app-server/git-head-branch";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: path.join(cwd, "missing-global-config"),
      GIT_CONFIG_SYSTEM: path.join(cwd, "missing-system-config"),
      GIT_TERMINAL_PROMPT: "0",
    },
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout.trim();
}

describe("probeCurrentGitBranch", () => {
  it("preserves unborn HEAD after fetching remote refs, then reads loose and packed branch refs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-head-probe-"));
    const local = path.join(root, "local");
    const seed = path.join(root, "seed");
    const remote = path.join(root, "origin.git");
    try {
      await mkdir(local);
      await mkdir(seed);
      await git(local, ["init", "-b", "main"]);
      expect(await probeCurrentGitBranch(local)).toEqual({});
      await expect(git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow();

      await git(root, ["init", "--bare", "-b", "main", remote]);
      await git(seed, ["init", "-b", "main"]);
      await writeFile(path.join(seed, "README.md"), "seed\n");
      await git(seed, ["add", "README.md"]);
      await git(seed, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      await git(seed, ["remote", "add", "origin", remote]);
      await git(seed, ["push", "origin", "main"]);
      await git(local, ["remote", "add", "origin", remote]);
      await git(local, ["fetch", "origin", "main:refs/remotes/origin/main"]);
      expect(await probeCurrentGitBranch(local)).toEqual({});
      await expect(git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).rejects.toThrow();

      await writeFile(path.join(local, "README.md"), "local\n");
      await git(local, ["add", "README.md"]);
      await git(local, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "local"]);
      expect(await probeCurrentGitBranch(local)).toEqual({ branch: "main" });
      expect(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
      await git(local, ["pack-refs", "--all"]);
      await rm(path.join(local, ".git", "refs", "heads", "main"), { force: true });
      expect(await probeCurrentGitBranch(local)).toEqual({ branch: "main" });
      await git(local, ["tag", "main"]);
      expect(await git(local, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("heads/main");
      expect(await probeCurrentGitBranch(local)).toBeUndefined();
      await git(local, ["pack-refs", "--all"]);
      expect(await probeCurrentGitBranch(local)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a linked worktree admin HEAD through a relative gitdir and common packed ref", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-worktree-head-"));
    const local = path.join(root, "local");
    const linked = path.join(root, "linked");
    try {
      await mkdir(local);
      await git(local, ["init", "-b", "main"]);
      await writeFile(path.join(local, "README.md"), "seed\n");
      await git(local, ["add", "README.md"]);
      await git(local, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"]);
      await git(local, ["worktree", "add", "-b", "feature/probe", linked]);
      const dotGit = path.join(linked, ".git");
      const link = await readFile(dotGit, "utf8");
      const match = /^gitdir: ([^\r\n]+)/.exec(link);
      expect(match).toBeTruthy();
      const admin = path.resolve(linked, match![1]);
      expect(await git(linked, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature/probe");
      expect(await probeCurrentGitBranch(linked)).toEqual({ branch: "feature/probe" });
      const relative = path.join(root, "relative");
      await mkdir(relative);
      await writeFile(path.join(relative, ".git"), "gitdir: " + path.relative(relative, admin) + "\n");
      expect(await probeCurrentGitBranch(relative)).toEqual({ branch: "feature/probe" });
      await git(local, ["pack-refs", "--all"]);
      await rm(path.join(local, ".git", "refs", "heads", "feature", "probe"), { force: true });
      expect(await probeCurrentGitBranch(linked)).toEqual({ branch: "feature/probe" });
      await git(linked, ["switch", "--detach", "HEAD"]);
      expect(await git(linked, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("HEAD");
      expect(await probeCurrentGitBranch(linked)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Git fallback for unsupported metadata and honors cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-unsupported-head-"));
    try {
      await git(root, ["init", "-b", "main"]);
      const controller = new AbortController();
      controller.abort();
      await expect(probeCurrentGitBranch(root, controller.signal)).rejects.toThrow();
      const config = path.join(root, ".git", "config");
      const originalConfig = await readFile(config, "utf8");
      await appendFile(config, "\n[extensions]\n\trefStorage = reftable\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      await writeFile(config, "[other]\n\trepositoryformatversion = 0\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      await appendFile(config, "\n[core]\n\tworktree = elsewhere\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(config, originalConfig);
      const head = path.join(root, ".git", "HEAD");
      const originalHead = await readFile(head, "utf8");
      await writeFile(head, "invalid HEAD\n");
      expect(await probeCurrentGitBranch(root)).toBeUndefined();
      await writeFile(head, originalHead);
      const prior = process.env.GIT_DIR;
      process.env.GIT_DIR = path.join(root, ".git");
      try {
        expect(await probeCurrentGitBranch(root)).toBeUndefined();
      } finally {
        if (prior === undefined) delete process.env.GIT_DIR;
        else process.env.GIT_DIR = prior;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
