import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { expect, it, onTestFinished, vi } from "vitest";
import { runGitCommand } from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, parseForgeRemote, readForgeRepositoryRemotes, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

it.each([8, 16])("shares a checkout's remote observation between attachment validation and ownership for %i worktrees", async (size) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-wave-"));
  const restore = isolateProcessGitEnvironment();
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "nonexistent-global-config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  onTestFinished(async () => {
    restore();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => runGitCommand(cwd, args);
  const repo = path.join(root, "repository");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "init");
  for (const remote of ["origin", "upstream"]) {
    await git(repo, "remote", "add", remote, `https://github.com/fixture/${remote}.git`);
    await git(repo, "symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`);
  }
  const checkouts = Array.from({ length: size }, (_, index) => path.join(root, `worktree-${index}`));
  for (const cwd of checkouts) await git(repo, "worktree", "add", "--detach", cwd);
  const plain = path.join(root, "plain");
  await mkdir(plain);
  const missing = path.join(root, "missing");
  const directories = [...checkouts, plain, missing];
  const prs: PrSummary[] = directories.map((cwd, index) => ({
    provider: "github.com", org: "fixture", repo: "origin", number: index + 1,
    state: "merged", headRefName: "topic", url: `https://github.com/fixture/origin/pull/${index + 1}`,
    linkedDirectoryPaths: [cwd],
  }));

  const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  onTestFinished(() => { launches.mockRestore(); });
  // The complete owner inventory validates automatic attachments, then resolves
  // primary owners for polling. A simultaneous page requests the same evidence.
  expect(await Promise.all([filterStoredDiscoveredPullRequests(prs), filterStoredDiscoveredPullRequests(prs)])).toEqual([prs, prs]);
  const owners = await Promise.all(directories.map((cwd) => resolveGitHubRepoForDirectory(cwd)));
  expect(owners).toEqual([...checkouts.map(() => ({ host: "github.com", owner: "fixture", repo: "origin" })), undefined, undefined]);

  // Each real checkout needs one effective-config observation and one HEAD
  // read per remote. Inconclusive paths preserve history without a Git launch.
  const remoteStarts = launches.mock.calls.filter(([, , purpose]) => purpose === "pr-remotes");
  const discoveryStarts = launches.mock.calls.filter(([, , purpose]) => purpose === "pr-discovery");
  expect({ remotes: remoteStarts.length, discovery: discoveryStarts.length }).toEqual({ remotes: size, discovery: size * 2 });
  expect(remoteStarts.map(([cwd]) => cwd).sort()).toEqual([...checkouts].sort());
  expect(discoveryStarts.every(([, args]) => args[0] === "symbolic-ref")).toBe(true);
});

it("matches Git across effective config changes and overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-config-"));
  const restore = isolateProcessGitEnvironment();
  process.env.GIT_CONFIG_GLOBAL = path.join(root, "global-config");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  onTestFinished(async () => {
    restore();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => runGitCommand(cwd, args);
  const repo = path.join(root, "repository");
  const plain = path.join(root, "plain");
  await Promise.all([mkdir(repo), mkdir(plain)]);
  await git(repo, "init", "-b", "main");
  await git(repo, "remote", "add", "origin", "forge:precise/fixture/project.git");
  await git(repo, "config", "--add", "remote.origin.url", "forge:fixture/mirror.git");
  await git(repo, "config", "--add", "remote.origin.pushurl", "https://github.com/fixture/push-only.git");
  await writeFile(process.env.GIT_CONFIG_GLOBAL!, [
    '[url "https://github.com/"]', "  insteadOf = forge:",
    '[url "https://gitlab.com/"]', "  insteadOf = forge:precise/",
    '[remote "global-only"]', "  url = https://github.com/fixture/global-only.git", "",
  ].join("\n"));

  const readGitRemotes = async (cwd: string) => {
    const listed = await git(cwd, "remote").catch(() => ({ stdout: "" }));
    const names = listed.stdout.trim().split(/\r?\n/).filter(Boolean);
    const outputs = await Promise.all(names.map((name) =>
      git(cwd, "remote", "get-url", "--all", name).catch(() => ({ stdout: "" }))));
    return outputs.flatMap(({ stdout }) => [...new Set(stdout.split(/\r?\n/).map((line) => line.trim()))]
      .flatMap((url) => { const repo = parseForgeRemote(url); return repo ? [repo] : []; }));
  };
  expect(await readForgeRepositoryRemotes(repo)).toEqual(await readGitRemotes(repo));
  // A global-only remote does not make a plain directory a PR workspace.
  expect(await readForgeRepositoryRemotes(plain)).toEqual(await readGitRemotes(plain));

  await git(repo, "config", "--global", "--remove-section", "remote.global-only");
  process.env.GIT_DIR = path.join(repo, ".git");
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "remote.origin.url";
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/fixture/from-command.git";
  clearGitHubRemoteCache();
  const overridden = await readGitRemotes(plain);
  expect(overridden.map(({ repo }) => repo)).toContain("from-command");
  expect(await readForgeRepositoryRemotes(plain)).toEqual(overridden);

  const configOnly = path.join(root, "alternate-config");
  await writeFile(configOnly, '[remote "origin"]\n  url = https://github.com/fixture/config-only.git\n');
  process.env.GIT_CONFIG = configOnly;
  clearGitHubRemoteCache();
  expect(await readForgeRepositoryRemotes(plain)).toEqual(await readGitRemotes(plain));
});
