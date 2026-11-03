import { ChildProcess, execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import * as git from "../app-server/git-executable";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { clearGitHubRemoteCache, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";

const execFileAsync = promisify(execFile);
// Every async launch reaches this method; Node's public typings omit it.
const spyOnLaunches = () => vi.spyOn(ChildProcess.prototype as unknown as { spawn(options: unknown): unknown }, "spawn");

describe("PR metadata launch budgets", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-launch-budget-"));
    clearGitHubRemoteCache();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });

  const attachment = (cwd: string): PrSummary => ({
    provider: "github.com", org: "fixture", repo: "project", number: 1,
    state: "merged", headRefName: "feature",
    url: "https://github.com/fixture/project/pull/1", linkedDirectoryPaths: [cwd],
  });

  it.each(["missing", "plain", "local-only"])("does not repeat default-branch launches for %s directories", async (kind) => {
    const cwd = path.join(root, kind);
    if (kind !== "missing") await mkdir(cwd);
    if (kind === "local-only") await git.runGitCommand(cwd, ["init", "-b", "main"]);
    const runner = vi.spyOn(git, "runGitCommand");
    const launches = spyOnLaunches();
    const pr = attachment(cwd);
    for (let round = 0; round < 5; round++) {
      expect(await filterStoredDiscoveredPullRequests([pr])).toEqual([pr]);
    }
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([["remote"]]);
    expect(launches).toHaveBeenCalledTimes(1);
  });

  it("uses one fallback-ref lookup for concurrent and unchanged consumers of a checkout", async () => {
    await git.runGitCommand(root, ["init", "-b", "feature"]);
    await git.runGitCommand(root, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
    const runner = vi.spyOn(git, "runGitCommand");
    const launches = spyOnLaunches();
    const pr = attachment(root);
    await Promise.all(Array.from({ length: 12 }, () => filterStoredDiscoveredPullRequests([pr])));
    for (let round = 0; round < 5; round++) await filterStoredDiscoveredPullRequests([pr]);
    // Identity's remote list + all URLs; defaults' remote list + remote HEAD
    // + one fallback-ref query. Git still owns both metadata reads.
    expect(runner).toHaveBeenCalledTimes(5);
    expect(launches).toHaveBeenCalledTimes(5);
    expect(runner.mock.calls.filter(([, args]) => args[0] === "for-each-ref")).toHaveLength(1);
  });

  it("shares only in-flight SSH expansion across repositories and re-reads after invalidation", async () => {
    let release!: (host: string) => void;
    const resolveSshHostname = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const options = {
      readRemotes: async () => [{ name: "origin", url: "fixture-host:fixture/project.git" }],
      resolveSshHostname,
    };
    const first = resolveGitHubRepoForDirectory(path.join(root, "first"), options);
    const second = resolveGitHubRepoForDirectory(path.join(root, "second"), options);
    await vi.waitFor(() => expect(resolveSshHostname).toHaveBeenCalledTimes(1));
    release("github.com");
    expect(await Promise.all([first, second])).toEqual(Array(2).fill({ host: "github.com", owner: "fixture", repo: "project" }));
    clearGitHubRemoteCache();
    resolveSshHostname.mockResolvedValue("gitlab.com");
    expect(await resolveGitHubRepoForDirectory(path.join(root, "first"), options)).toMatchObject({ host: "gitlab.com" });
    expect(resolveSshHostname).toHaveBeenCalledTimes(2);
  });

  it.skipIf(process.platform === "win32")("observes a changed SSH Include on expiry without retaining a hostname cache", async () => {
    let now = 0;
    const mainConfig = path.join(root, "ssh-config");
    const config = path.join(root, "included-ssh-config");
    await writeFile(mainConfig, `Include "${config}"\n`);
    await writeFile(config, "Host fixture-host\n  HostName github.com\n");
    const resolveSshHostname = vi.fn(async (host: string) => {
      const { stdout } = await execFileAsync("ssh", ["-G", "-F", mainConfig, "-o", "CanonicalizeHostname=no", host]);
      return stdout.match(/^hostname (.+)$/m)?.[1];
    });
    const options = {
      readRemotes: async () => [{ name: "origin", url: "fixture-host:fixture/project.git" }],
      resolveSshHostname, now: () => now,
    };
    const launches = spyOnLaunches();
    const reads = await Promise.all([root, path.join(root, "second")].map((cwd) => resolveGitHubRepoForDirectory(cwd, options)));
    expect(reads.map((repo) => repo?.host)).toEqual(["github.com", "github.com"]);
    expect(launches).toHaveBeenCalledTimes(1);
    expect(await resolveGitHubRepoForDirectory(root, options)).toMatchObject({ host: "github.com" });
    expect(launches).toHaveBeenCalledTimes(1);
    await writeFile(config, "Host fixture-host\n  HostName gitlab.com\n");
    now = 5 * 60_000;
    expect(await resolveGitHubRepoForDirectory(root, options)).toMatchObject({ host: "gitlab.com" });
    expect(resolveSshHostname).toHaveBeenCalledTimes(2);
    expect(launches).toHaveBeenCalledTimes(2);
  });

  it("refreshes changed remotes and default refs at their existing freshness boundaries", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await git.runGitCommand(root, ["init", "-b", "feature"]);
    await git.runGitCommand(root, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
    await git.runGitCommand(root, ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    const pr = attachment(root);
    expect(await filterStoredDiscoveredPullRequests([pr])).toEqual([pr]);
    await git.runGitCommand(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature"]);
    now += 60_001;
    // Preserve symbolic-ref semantics even when its target was not fetched.
    expect(await filterStoredDiscoveredPullRequests([pr])).toEqual([]);
    await git.runGitCommand(root, ["remote", "set-url", "origin", "https://github.com/other/project.git"]);
    await git.runGitCommand(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    now += 5 * 60_000;
    expect(await filterStoredDiscoveredPullRequests([pr])).toEqual([]);
    expect(await resolveGitHubRepoForDirectory(root)).toMatchObject({ owner: "other" });
    await git.runGitCommand(root, ["remote", "set-url", "origin", "https://github.com/fixture/project.git"]);
    clearGitHubRemoteCache();
    expect(await resolveGitHubRepoForDirectory(root)).toMatchObject({ owner: "fixture" });
  });

  it("keeps worktree-specific remote configuration separate within one common repository", async () => {
    const sibling = path.join(root, "sibling");
    await git.runGitCommand(root, ["init", "-b", "feature"]);
    await git.runGitCommand(root, ["-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
    await git.runGitCommand(root, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
    await git.runGitCommand(root, ["worktree", "add", "-b", "sibling", sibling]);
    await git.runGitCommand(root, ["config", "extensions.worktreeConfig", "true"]);
    await git.runGitCommand(root, ["config", "--unset-all", "remote.origin.url"]);
    await git.runGitCommand(root, ["config", "--worktree", "remote.origin.url", "https://github.com/fixture/project.git"]);
    await git.runGitCommand(sibling, ["config", "--worktree", "remote.origin.url", "https://github.com/other/project.git"]);
    const [primaryRemotes, siblingRemotes] = await Promise.all([
      resolveGitHubRepoForDirectory(root), resolveGitHubRepoForDirectory(sibling),
    ]);
    expect(primaryRemotes).toMatchObject({ owner: "fixture" });
    expect(siblingRemotes).toMatchObject({ owner: "other" });
    const [primaryCommon, siblingCommon] = await Promise.all([root, sibling].map((cwd) => git.runGitCommand(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
    expect(primaryCommon.stdout).toBe(siblingCommon.stdout);
  });
});
