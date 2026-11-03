import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import * as git from "../app-server/git-executable";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { clearGitHubRemoteCache, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";

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
    const pr = attachment(cwd);
    for (let round = 0; round < 5; round++) {
      expect(await filterStoredDiscoveredPullRequests([pr])).toEqual([pr]);
    }
    expect(runner.mock.calls.map(([, args]) => args)).toEqual([["remote"]]);
  });

  it("uses one fallback-ref lookup for concurrent and unchanged consumers of a checkout", async () => {
    await git.runGitCommand(root, ["init", "-b", "feature"]);
    await git.runGitCommand(root, ["remote", "add", "origin", "https://github.com/fixture/project.git"]);
    const runner = vi.spyOn(git, "runGitCommand");
    const pr = attachment(root);
    await Promise.all(Array.from({ length: 12 }, () => filterStoredDiscoveredPullRequests([pr])));
    for (let round = 0; round < 5; round++) await filterStoredDiscoveredPullRequests([pr]);
    // remote list + all URLs + remote HEAD + one fallback-ref query.
    expect(runner).toHaveBeenCalledTimes(4);
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

  it("observes a changed SSH Include on the existing remote-cache expiry boundary", async () => {
    let now = 0;
    const config = path.join(root, "included-ssh-config");
    await writeFile(config, "github.com");
    const { readFile } = await import("node:fs/promises");
    const resolveSshHostname = vi.fn(async () => (await readFile(config, "utf8")).trim());
    const options = {
      readRemotes: async () => [{ name: "origin", url: "fixture-host:fixture/project.git" }],
      resolveSshHostname, now: () => now,
    };
    expect(await resolveGitHubRepoForDirectory(root, options)).toMatchObject({ host: "github.com" });
    await writeFile(config, "gitlab.com");
    now = 5 * 60_000;
    expect(await resolveGitHubRepoForDirectory(root, options)).toMatchObject({ host: "gitlab.com" });
    expect(resolveSshHostname).toHaveBeenCalledTimes(2);
  });
});
