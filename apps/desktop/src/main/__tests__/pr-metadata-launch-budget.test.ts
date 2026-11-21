import { ChildProcess, execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import * as git from "../app-server/git-executable";
import { filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import { PR_METADATA_PRIORITY } from "../pr-status/pr-metadata-process";
import {
  clearGitHubRemoteCache,
  parseForgeRemote,
  readForgeRepositoryRemotes,
  resolveGitHubRepoForDirectory,
} from "../pr-status/git-remote";

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
    // Let the admitted child discover missing checkouts without touching the
    // owner's filesystem pool. The negative answer still coalesces and caches.
    const expected = [["remote"]];
    expect(runner.mock.calls.map(([, args]) => args)).toEqual(expected);
    expect(launches).toHaveBeenCalledTimes(expected.length);
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

  it.each([132, 264])("matches the call and concurrency model for three consumers of %i checkout identities", async (size) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let active = 0;
    let peak = 0;
    // Feed the mock runner relative paths so it can exercise admission with
    // all callers ready at the same time, independent of filesystem timing.
    const directories = Array.from({ length: size }, (_, index) => path.join(path.basename(root), `${index}`));
    const rejected = new Set(directories.filter((_, index) => index % 3 === 0));
    const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (cwd, args) => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      if (rejected.has(cwd)) throw new Error("inconclusive repository");
      const stdout = args[0] === "symbolic-ref" ? "origin/main\n"
        : args.length === 1 ? "origin\n" : "https://github.com/fixture/project.git\n";
      return { stdout, stderr: "" };
    });
    const prs = directories.map((cwd) => ({ ...attachment(cwd), headRefName: "main" }));
    const retained = prs.filter((pr) => rejected.has(pr.linkedDirectoryPaths![0]!));
    const first = filterStoredDiscoveredPullRequests(prs);
    const second = filterStoredDiscoveredPullRequests(prs);
    // A queued or running probe still has one owner when a freshness window
    // elapses. Only a completed observation can become stale.
    now += 60_001;
    const third = filterStoredDiscoveredPullRequests(prs);
    expect(await Promise.all([first, second, third])).toEqual([retained, retained, retained]);
    expect({ calls: runner.mock.calls.length, peak }).toEqual({
      calls: (size - rejected.size) * 4 + rejected.size,
      peak: 8,
    });
    for (const cwd of directories) {
      const commands = runner.mock.calls.filter(([path]) => path === cwd).map(([, args]) => args[0]);
      expect(commands).toEqual(rejected.has(cwd) ? ["remote"] : ["remote", "remote", "remote", "symbolic-ref"]);
    }
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

  it("promotes a shared selected checkout ahead of a cold scan and drops cancelled exclusive work", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const cwd = (index: number) => path.join(path.basename(root), `${index}`);
    const starts: string[] = [];
    const selected: string[] = [];
    let ready!: () => void;
    const saturated = new Promise<void>((resolve) => { ready = resolve; });
    const runner = vi.spyOn(git, "runGitCommand").mockImplementation(async (path, args) => {
      starts.push(path);
      if (starts.length === 8) ready();
      if (path === cwd(40)) selected.push(args.join(" "));
      if (Number(path.split(/[\\/]/).at(-1)) < 8) await held;
      return { stdout: args.length === 1 ? "origin\n" : "https://github.com/fixture/project.git\n", stderr: "" };
    });
    const read = (index: number) => resolveGitHubRepoForDirectory(cwd(index));
    const scan = Array.from({ length: 41 }, (_, index) => read(index));
    await saturated;
    expect(starts).toEqual(Array.from({ length: 8 }, (_, index) => cwd(index)));
    const controller = new AbortController();
    const cancelled = resolveGitHubRepoForDirectory(cwd(41), {
      demand: { priority: () => PR_METADATA_PRIORITY.selected, signal: controller.signal },
    }).catch((error: unknown) => error);
    const cancelledShared = resolveGitHubRepoForDirectory(cwd(39), {
      demand: { priority: () => PR_METADATA_PRIORITY.selected, signal: controller.signal },
    }).catch((error: unknown) => error);
    const pageRead = resolveGitHubRepoForDirectory(cwd(38), { demand: { priority: () => PR_METADATA_PRIORITY.page } });
    const selectedRead = resolveGitHubRepoForDirectory(cwd(40), { demand: { priority: () => PR_METADATA_PRIORITY.selected } });
    await Promise.resolve();
    // Both owners of checkout 40 should share its commands. Checkout 41 has
    // only the consumer that aborts, so none of its queued work should start.
    controller.abort();
    release();
    const resolved = await Promise.all([...scan, selectedRead, pageRead]);
    expect(resolved.every((repo) => repo?.repo === "project")).toBe(true);
    expect(await cancelled).toBe(controller.signal.reason);
    expect(await cancelledShared).toBe(controller.signal.reason);
    expect(starts[8]).toBe(cwd(40));
    expect(starts.indexOf(cwd(38))).toBeLessThan(starts.indexOf(cwd(39)));
    expect(starts.lastIndexOf(cwd(40))).toBeLessThan(starts.indexOf(cwd(39)));
    expect(selected).toEqual(["remote", "remote get-url --all origin"]);
    expect(starts).not.toContain(cwd(41));
    await expect(read(41)).resolves.toMatchObject({ repo: "project" });
    expect(runner.mock.calls.filter(([path]) => path === cwd(41))).toHaveLength(2);
  });

  it("coalesces aliases while more than 128 distinct hosts are pending", async () => {
    let finish!: (hostname: string) => void;
    const pending = new Promise<string>((resolve) => { finish = resolve; });
    const resolveSshHostname = vi.fn((_host: string) => pending);
    const read = (host: string, directory: string) => resolveGitHubRepoForDirectory(path.join(root, directory), {
      readRemotes: async () => [{ name: "origin", url: `${host}:fixture/project.git` }], resolveSshHostname,
    });
    const reads = Array.from({ length: 129 }, (_, index) => read(`host-${index}`, `first-${index}`));
    reads.push(read("host-128", "second"));
    finish("github.com");
    const result = await Promise.all(reads);
    expect(result.every((repo) => repo?.host === "github.com")).toBe(true);
    expect(resolveSshHostname.mock.calls).toHaveLength(129);
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

  it.each([8, 16])("matches Git's remote configuration for %i worktrees sharing a common directory", async (size) => {
    const command = (cwd: string, ...args: string[]) => git.runGitCommand(cwd, args);
    const repository = path.join(root, "repository");
    await mkdir(repository);
    await command(repository, "init", "-b", "main");
    await command(repository, "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
    await command(repository, "config", "extensions.worktreeConfig", "true");
    await command(repository, "config", "url.https://github.com/.insteadOf", "fixture:");
    const include = path.join(repository, "conditional.conf");
    await writeFile(include, "[url \"https://gitlab.com/\"]\n\tinsteadOf = selected:\n");
    await command(repository, "config", "includeIf.onbranch:worktree-0.path", include);
    const dirs: string[] = [];
    for (let index = 0; index < size; index++) {
      const cwd = path.join(root, `worktree-${index}`);
      await command(repository, "worktree", "add", "-b", `worktree-${index}`, cwd);
      await command(cwd, "config", "--worktree", "--add", "remote.origin.url", `fixture:fixture/checkout-${index}.git`);
      await command(cwd, "config", "--worktree", "--add", "remote.origin.url", "fixture:fixture/mirror.git");
      await command(cwd, "config", "--worktree", "remote.origin.pushurl", "https://github.com/fixture/push-only.git");
      if (index === 0) await command(cwd, "config", "--worktree", "remote.selected.url", "selected:fixture/subgroup/project.git");
      dirs.push(cwd);
    }
    const remotesByDir: ReturnType<typeof parseForgeRemote>[][] = [];
    for (const cwd of dirs) {
      const { stdout: names } = await command(cwd, "remote");
      const remotes: ReturnType<typeof parseForgeRemote>[] = [];
      for (const name of names.trim().split(/\r?\n/)) {
        const { stdout } = await command(cwd, "remote", "get-url", "--all", name);
        remotes.push(...stdout.trim().split(/\r?\n/).map(parseForgeRemote));
      }
      remotesByDir.push(remotes);
    }
    const launches = spyOnLaunches();
    const wave = () => Promise.all(dirs.map(readForgeRepositoryRemotes));
    const [first, second, origins] = await Promise.all([
      wave(), wave(), Promise.all(dirs.map((cwd) => resolveGitHubRepoForDirectory(cwd))),
    ]);
    expect(first).toEqual(remotesByDir);
    expect(second).toEqual(first);
    expect(origins.map((remote) => remote?.repo)).toEqual(dirs.map((_, index) => `checkout-${index}`));
    expect(first[0]?.at(-1)).toEqual({ host: "gitlab.com", owner: "fixture/subgroup", repo: "project" });
    expect(first[1]?.map((remote) => remote.repo)).toEqual(["checkout-1", "mirror"]);
    expect(launches).toHaveBeenCalledTimes(2 * size + 1);
  });
});
