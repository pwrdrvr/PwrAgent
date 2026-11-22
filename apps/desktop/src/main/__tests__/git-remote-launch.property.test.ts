import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, parseForgeRemote, readForgeRepositoryRemotes, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { detectPullRequestsForThread, filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { PR_METADATA_PRIORITY, runPrMetadataGit } from "../pr-status/pr-metadata-process";
import { readProvenRemoteHeads } from "../pr-status/pr-remote-heads";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

const { runGitCommand } = gitExecutable;
const originConfig = ["local", "remote.origin.url\nhttps://github.com/fixture/project.git", ""].join("\0");

it("keeps a selected PR read moving when background paths cannot complete filesystem discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-unresponsive-"));
  const restoreEnv = isolateProcessGitEnvironment(root);
  await runGitCommand(root, ["init", "-b", "main"]);
  const { realpath } = await vi.importActual<typeof fs>("node:fs/promises");
  let release!: () => void;
  const unresponsive = new Promise<void>((resolve) => { release = resolve; });
  const probe = vi.spyOn(fs, "realpath").mockImplementation(async (cwd) => {
    if (String(cwd).includes("unresponsive-checkout")) await unresponsive;
    return await realpath(cwd);
  });
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockResolvedValue({ stdout: originConfig, stderr: "" });
  onTestFinished(async () => {
    probe.mockRestore();
    runner.mockRestore();
    restoreEnv();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });
  const background = Array.from({ length: 16 }, (_, index) =>
    resolveGitHubRepoForDirectory(path.join(root, `unresponsive-checkout-${index}`)));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const selected = resolveGitHubRepoForDirectory(root, { demand: { priority: () => PR_METADATA_PRIORITY.selected } });
  try {
    const result = await Promise.race([selected, new Promise<void>((resolve) => setImmediate(resolve))]);
    expect(result).toEqual({ host: "github.com", owner: "fixture", repo: "project" });
  } finally {
    release();
    await Promise.all([...background, selected]);
  }
});

it.skipIf(process.platform === "win32")("reserves owner filesystem capacity after background ref probes time out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-stalled-refs-"));
  const restoreEnv = isolateProcessGitEnvironment(root);
  const { realpath } = await vi.importActual<typeof fs>("node:fs/promises");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let peak = 0;
  const probe = vi.spyOn(fs, "realpath").mockImplementation(async (cwd) => {
    if (!path.basename(String(cwd)).startsWith("stalled-refs-")) return await realpath(cwd);
    peak = Math.max(peak, ++active);
    await held;
    active--;
    return await realpath(cwd);
  });
  onTestFinished(async () => {
    release();
    probe.mockRestore();
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  });
  await runGitCommand(root, ["init", "-b", "main"]);

  // Simulate libuv calls that remain blocked after the JS probe's deadline.
  // Inventory can fall back and selected Git can run before the mount returns.
  const wave = () => Promise.all(Array.from({ length: 12 }, (_, index) =>
    readProvenRemoteHeads(path.join(root, `stalled-refs-${index}`), ["origin", "upstream"])));
  await expect(wave()).resolves.toEqual(Array(12).fill(undefined));
  const stillActive = active;
  await expect(wave()).resolves.toEqual(Array(12).fill(undefined));
  const { stdout } = await runPrMetadataGit(root, ["rev-parse", "--is-inside-work-tree"],
    { purpose: "pr-discovery" }, { priority: () => PR_METADATA_PRIORITY.selected });
  expect(stdout.trim()).toBe("true");
  expect(peak).toBeLessThanOrEqual(3);
  expect(active).toBe(stillActive);
});

it("keeps attachment history and skips forge discovery when a checkout vanishes after its config read", async () => {
  const restoreEnv = isolateProcessGitEnvironment();
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (_cwd, args) => {
    if (args[0] === "config") return { stdout: originConfig, stderr: "" };
    throw new Error("checkout vanished");
  });
  onTestFinished(() => { runner.mockRestore(); restoreEnv(); clearGitHubRemoteCache(); });
  const pr: PrSummary = {
    provider: "github.com", org: "old", repo: "project", number: 1, state: "merged",
    headRefName: "topic", url: "https://github.com/old/project/pull/1", linkedDirectoryPaths: ["vanished-history"],
  };
  const fetchAllPullRequestsForBranch = vi.fn(async () => []);
  const [history, discovered] = await Promise.all([
    filterStoredDiscoveredPullRequests([pr]),
    detectPullRequestsForThread({ fetcher: { fetchAllPullRequestsForBranch }, branch: "topic", directoryPaths: ["vanished-discovery"] }),
  ]);
  expect({ history, discovered, forgeLookups: fetchAllPullRequestsForBranch.mock.calls.length }).toEqual({
    history: [pr], discovered: [], forgeLookups: 0,
  });
  for (const cwd of ["vanished-history", "vanished-discovery"]) {
    expect(runner.mock.calls.filter(([path]) => path === cwd).map(([, args]) => args[0]))
      .toEqual(["config", "symbolic-ref", "for-each-ref", "remote"]);
  }
});

it.each([8, 16])("shares a checkout's remote observation between attachment validation and ownership for %i worktrees", async (size) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-wave-"));
  const restore = isolateProcessGitEnvironment(root);
  onTestFinished(async () => {
    restore();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => runGitCommand(cwd, args);
  const repo = path.join(root, "repository");
  await mkdir(repo);
  await git(repo, "init", "-b", "main", "--ref-format=files", "--object-format=sha1");
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

  // The Git-confirmed files observation replaces both dangling HEAD reads
  // on supported platforms. Inconclusive paths cache a negative remote answer.
  const headReads = process.platform === "win32" ? ["symbolic-ref", "symbolic-ref"] : ["rev-parse"];
  const remoteStarts = launches.mock.calls.filter(([, , purpose]) => purpose === "pr-remotes");
  const discoveryStarts = launches.mock.calls.filter(([, , purpose]) => purpose === "pr-discovery");
  expect({ remotes: remoteStarts.length, discovery: discoveryStarts.length }).toEqual({ remotes: size + 3, discovery: size * headReads.length });
  expect(remoteStarts.map(([cwd]) => cwd).sort()).toEqual([...directories, missing].sort());
  for (const cwd of checkouts) {
    expect(discoveryStarts.filter(([directory]) => directory === cwd).map(([, args]) => args[0])).toEqual(headReads);
  }
});

it("matches Git across effective config changes and overrides", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-pr-config-"));
  const restore = isolateProcessGitEnvironment(root);
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
