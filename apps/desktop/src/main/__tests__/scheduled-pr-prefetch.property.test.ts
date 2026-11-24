import { appendFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { bundledGitExecutable } from "../bundled-git";
import { GitSubprocessDiagnostics, gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, readObservedGitOrigin, REMOTE_CONFIG_KEYS, resolveGitHubRepoForDirectory, resolveGitHubReposForDirectory } from "../pr-status/git-remote";
import { createScheduledPrPrefetchRepoResolver, detectPullRequestsForThread } from "../pr-status/pr-detection";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const runGitCommand = gitExecutable.runGitCommand;
const readGit = async (cwd: string, ...args: string[]) => (await runGitCommand(cwd, args)).stdout.trim();
const topics = Array.from({ length: 12 }, (_, index) => `topic-${index}`);
const remoteHead = (cwd: string, remote: string, branch: string) =>
  readGit(cwd, "symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`);

async function fixture(refFormat = "files", objectFormat = "sha1") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-scheduled-pr-prefetch-"));
  const restoreEnv = isolateProcessGitEnvironment(cwd);
  onTestFinished(async () => {
    restoreEnv();
    clearGitHubRemoteCache();
    await rm(cwd, { recursive: true, force: true });
  });
  await readGit(cwd, "init", "-b", "main", `--ref-format=${refFormat}`, `--object-format=${objectFormat}`);
  await readGit(cwd, "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "fixture");
  const refs = [...topics, "release", "tracks-default", "tracks-other"].map((branch) => `refs/heads/${branch}`);
  for (const remote of ["origin", "upstream"]) {
    await readGit(cwd, "remote", "add", remote, `https://github.com/fixture/${remote}.git`);
    refs.push(...["main", "release", "other"].map((branch) => `refs/remotes/${remote}/${branch}`));
    await remoteHead(cwd, remote, "main");
  }
  const oid = await readGit(cwd, "rev-parse", "HEAD");
  await runGitCommand(cwd, ["update-ref", "--stdin"], { input: refs.map((ref) => `create ${ref} ${oid}\n`).join("") });
  await readGit(cwd, "branch", "--set-upstream-to=origin/main", "tracks-default");
  await readGit(cwd, "branch", "--set-upstream-to=upstream/other", "tracks-other");
  return cwd;
}

/** Native Git is the oracle for remote eligibility, the current remote HEADs, and tracking. */
async function oracle(cwd: string) {
  const remotes = (await readGit(cwd, "remote")).split("\n").filter(Boolean);
  const defaults = new Map<string, string>();
  const repos = new Set<string>();
  for (const remote of remotes) {
    const ref = await readGit(cwd, "symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`).catch(() => "");
    if (ref.startsWith(`${remote}/`)) defaults.set(remote, ref.slice(remote.length + 1));
    for (const url of (await readGit(cwd, "remote", "get-url", "--all", remote)).split("\n")) {
      if (/^https:\/\/github\.com\//.test(url)) repos.add(url);
    }
  }
  const refs = (await readGit(cwd, "for-each-ref", "--format=%(refname)%09%(upstream:remotename)%09%(upstream:remoteref)", "refs/heads"))
    .split("\n").map((row) => row.slice("refs/heads/".length));
  const defaultNames = new Set(defaults.values());
  if (!defaultNames.size) {
    const local = new Set(refs.map((ref) => ref.split("\t")[0]));
    const fallback = ["main", "master", "develop", "trunk"].find((branch) => local.has(branch));
    if (fallback) defaultNames.add(fallback);
  }
  const disallowed = new Set(defaultNames);
  for (const ref of refs) {
    const [branch, remote, target] = ref.split("\t");
    if (defaults.has(remote) && target !== `refs/heads/${defaults.get(remote)}` && target !== `refs/heads/${branch}`) {
      disallowed.add(branch);
    }
  }
  return (branch: string) => disallowed.has(branch) ? [] : [...repos].sort();
}

function recordPrefetchStarts() {
  const diagnostics = new GitSubprocessDiagnostics(() => 0);
  const recorder = vi.spyOn(gitSubprocessDiagnostics, "startGit")
    .mockImplementation((cwd, args, purpose) => diagnostics.startGit(cwd, args, purpose));
  onTestFinished(() => { recorder.mockRestore(); });
  return {
    get calls() { return recorder.mock.calls; },
    clear: () => recorder.mockClear(),
    snapshot: () => diagnostics.snapshot().buckets[0],
  };
}

async function expectEligible(
  resolve: ReturnType<typeof createScheduledPrPrefetchRepoResolver>, cwd: string, branch: string, expected: string[],
) {
  const repos = await resolve(cwd, branch);
  expect(repos.map(({ host, owner, repo }) => `https://${host}/${owner}/${repo}.git`).sort()).toEqual(expected);
}

it.skipIf(process.platform === "win32")("launches checkout metadata once for twelve serial branches", async () => {
  const cwd = await fixture();
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of topics) await expectEligible(resolve, cwd, branch, expected(branch));

  // One checkout observation is enough. Tracking still comes from Git for each branch.
  const { rows, startsByCaller } = starts.snapshot();
  expect(startsByCaller).toEqual({
    "pr-scheduled-prefetch": 14, "pr-live-branch-lookup": 0, "pr-stored-attachment-validation": 0,
  });
  expect(Object.fromEntries(rows.map((row) => [`${row.purpose}/${row.command}`, row.started]))).toEqual({
    "pr-remotes/config": 1,
    "pr-discovery/rev-parse": 1,
    "pr-discovery/refs": 12,
  });
});

it.skipIf(process.platform === "win32")("shares checkout metadata between an eligible topic and a renamed upstream", async () => {
  const cwd = await fixture();
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of ["topic-2", "tracks-other"]) await expectEligible(resolve, cwd, branch, expected(branch));
  expect(starts.calls.map(([, args]) => args[0])).toEqual(["config", "rev-parse", "for-each-ref", "for-each-ref"]);
});

it.skipIf(process.platform === "win32")("keeps Git eligibility and constant checkout probes for generated serial branch sets", async () => {
  const cwd = await fixture();
  const expected = await oracle(cwd);
  const starts = recordPrefetchStarts();
  await fc.assert(fc.asyncProperty(fc.shuffledSubarray([...topics, "main", "tracks-default", "tracks-other"], {
    minLength: 2,
  }), async (branches) => {
    clearGitHubRemoteCache();
    starts.clear();
    const resolve = createScheduledPrPrefetchRepoResolver();
    for (const branch of branches) await expectEligible(resolve, cwd, branch, expected(branch));

    // The number of metadata launches depends on checkout observations, independent of branch order or count.
    expect(starts.calls.filter(([, args]) => args[0] !== "for-each-ref").map(([, args]) => args[0]))
      .toEqual(["config", "rev-parse"]);
  }), { numRuns: 12 });
});

it("uses the existing Git remote HEAD fallback with one configured remote", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "remove", "upstream");
  const expected = await oracle(cwd);
  const starts = recordPrefetchStarts();
  const resolve = createScheduledPrPrefetchRepoResolver();
  for (const branch of ["topic-0", "topic-1"]) await expectEligible(resolve, cwd, branch, expected(branch));
  const metadata = process.platform === "win32" ? ["config", "remote"] : ["config", "rev-parse"];
  expect(starts.calls.map(([, args]) => args[0])).toEqual([
    ...metadata, "symbolic-ref", "for-each-ref", ...(process.platform === "win32" ? metadata : []), "symbolic-ref", "for-each-ref",
  ]);
});

async function singleBranchClone() {
  const source = await fixture();
  const cwd = path.join(source, "single-branch");
  await readGit(source, "clone", "--single-branch", "--branch", "main", "--", source, cwd);
  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/single-branch.git");
  await remoteHead(cwd, "origin", "main");
  const branches = topics.slice(0, 3);
  for (const branch of branches) await readGit(cwd, "branch", branch);
  return { cwd, branches };
}

it.each(["warm", "cold"])("avoids repeated URL probes in a %s single-branch clone", async (cache) => {
  const { cwd, branches } = await singleBranchClone();
  if (cache === "warm") await resolveGitHubRepoForDirectory(cwd);
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of branches) await expectEligible(resolve, cwd, branch, expected(branch));

  const commands = starts.calls.map(([, args]) => args.slice(0, args[0] === "remote" ? 2 : 1).join(" "));
  expect(commands.filter((command) => command === "remote get-url")).toHaveLength(cache === "warm" ? 0 : 1);
  expect(commands.filter((command) => command === "config")).toHaveLength(cache === "warm" ? 0 : 1);
  // Only the first cold lookup reads URLs after listing remotes.
  expect(commands.filter((command) => command === "remote")).toHaveLength(cache === "warm" ? 3 : 4);
  expect(commands.filter((command) => command === "symbolic-ref")).toHaveLength(3);
  expect(commands.filter((command) => command === "for-each-ref")).toHaveLength(3);

  await readGit(cwd, "remote", "rename", "origin", "renamed");
  await readGit(cwd, "remote", "set-url", "renamed", "https://github.com/fixture/rename.git");
  await expectEligible(resolve, cwd, "topic-3", (await oracle(cwd))("topic-3"));
});

it("shares complete HTTPS URL reads across prefetch and live discovery", async () => {
  const { cwd, branches: [first, second] } = await singleBranchClone();
  for (const remote of ["mirror", "upstream"]) {
    await readGit(cwd, "remote", "add", remote, `https://github.com/fixture/${remote}.git`);
    await remoteHead(cwd, remote, "main");
  }
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of [first, second]) await expectEligible(resolve, cwd, branch, expected(branch));
  const fetchAllPullRequestsForBranch = vi.fn(async () => []);
  for (const branch of [first, second]) {
    await detectPullRequestsForThread({ branch, directoryPaths: [cwd], fetcher: { fetchAllPullRequestsForBranch } });
  }

  expect(fetchAllPullRequestsForBranch.mock.calls).toEqual([first, second].map((branch) => [{ cwd, branch }]));
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(3);
});

it.each(["cold", "warm"])("keeps the %s retry window for a missing checkout", async (cache) => {
  const source = await fixture();
  const cwd = path.join(source, "missing");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  if (cache === "warm") await resolveGitHubRepoForDirectory(cwd);
  const retryAt = readObservedGitOrigin(cwd)?.retryAt ?? now + 5 * 60_000;
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of topics.slice(0, 3)) await expectEligible(resolve, cwd, branch, []);
  expect(starts.calls.map(([, args]) => args[0])).toEqual(cache === "cold" ? ["config", "remote"] : []);
  expect(readObservedGitOrigin(cwd)?.conclusive).toBe(cache === "warm" ? false : undefined);

  await readGit(source, "worktree", "add", "--detach", cwd);
  now = retryAt;
  await expectEligible(resolve, cwd, "topic-3", (await oracle(cwd))("topic-3"));
});

it("refreshes fallback URLs at the original live cache expiry", async () => {
  const { cwd, branches: [first, second] } = await singleBranchClone();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  await resolveGitHubRepoForDirectory(cwd);
  const { retryAt } = readObservedGitOrigin(cwd)!;
  now = retryAt - 1;
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, first, (await oracle(cwd))(first));
  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/after-expiry.git");

  now = retryAt;
  const expected = (await oracle(cwd))(second);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, second, expected);
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(1);
});

it.each([0, 1])("follows an owner remote refresh %i ms into the batch", async (elapsed) => {
  const { cwd, branches: [first, second] } = await singleBranchClone();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  await resolveGitHubRepoForDirectory(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, first, (await oracle(cwd))(first));

  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/owner-refresh.git");
  now += elapsed;
  await expect(resolveGitHubRepoForDirectory(cwd, { fresh: true })).resolves.toEqual({
    host: "github.com", owner: "fixture", repo: "owner-refresh",
  });
  const expected = (await oracle(cwd))(second);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, second, expected);
  // The current names agree with the owner's native URL read, which can be reused.
  expect(starts.calls.map(([, args]) => args.slice(0, args[0] === "remote" ? 2 : 1).join(" ")))
    .toEqual(["remote", "symbolic-ref", "for-each-ref"]);
});

async function holdSshResolution(cwd: string) {
  const bin = path.join(cwd, "bin");
  const release = path.join(cwd, "release-ssh");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"),
    '#!/bin/sh\nwhile [ ! -f "$PWRAGENT_TEST_PREFETCH_SSH_RELEASE" ]; do sleep 0.01; done\nprintf "hostname github.com\\n"\n',
    { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("PWRAGENT_TEST_PREFETCH_SSH_RELEASE", release);
  const startedSsh = Promise.withResolvers<void>();
  const startDiagnostic = gitSubprocessDiagnostics.start.bind(gitSubprocessDiagnostics);
  const diagnostic = vi.spyOn(gitSubprocessDiagnostics, "start").mockImplementation((...args) => {
    if (args[0] === "ssh-config") startedSsh.resolve();
    return startDiagnostic(...args);
  });
  onTestFinished(() => { vi.unstubAllEnvs(); diagnostic.mockRestore(); });
  return { started: startedSsh.promise, release: () => writeFile(release, "") };
}

it.skipIf(process.platform === "win32")("prefers the owner URL sampled during a delayed scheduled SSH read", async () => {
  const { cwd, branches: [first, second] } = await singleBranchClone();
  const ssh = await holdSshResolution(cwd);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/before-owner-read.git");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const scheduled = resolve(cwd, first);
  try {
    await Promise.race([ssh.started, scheduled.then(() => { throw new Error("Scheduled lookup did not expand SSH"); })]);
    await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/owner-overlap.git");
    now++;
    await expect(resolveGitHubRepoForDirectory(cwd, { fresh: true })).resolves.toEqual({
      host: "github.com", owner: "fixture", repo: "owner-overlap",
    });
    now++;
  } finally {
    await ssh.release();
    await scheduled;
  }

  const expected = (await oracle(cwd))(second);
  const completed = await scheduled;
  expect(completed.map(({ host, owner, repo }) => `https://${host}/${owner}/${repo}.git`)).toEqual(expected);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, second, expected);
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(0);
});

it("prefers the owner URLs when native remote probes span an owner refresh", async () => {
  const cwd = await fixture();
  await readGit(cwd, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  const originSampled = Promise.withResolvers<void>();
  const releaseUpstream = Promise.withResolvers<void>();
  let delayScheduledReads = true;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const delay = delayScheduledReads && directory === cwd && args[0] === "remote" && args[1] === "get-url";
    if (delay && args[3] === "upstream") await releaseUpstream.promise;
    const result = await runGitCommand(directory, args, options);
    if (delay && args[3] === "origin") originSampled.resolve();
    return result;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const resolve = createScheduledPrPrefetchRepoResolver();
  const scheduled = resolve(cwd, "topic-0");
  try {
    await Promise.race([originSampled.promise, scheduled.then(() => { throw new Error("Scheduled lookup did not read the origin URL"); })]);
    delayScheduledReads = false;
    await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/owner-overlap.git");
    expect((await resolveGitHubReposForDirectory(cwd, { fresh: true })).map(({ repo }) => repo)).toEqual(["owner-overlap", "upstream"]);
  } finally {
    releaseUpstream.resolve();
    await scheduled;
  }

  const expected = await oracle(cwd);
  expect((await scheduled).map(({ host, owner, repo }) => `https://${host}/${owner}/${repo}.git`).sort()).toEqual(expected("topic-0"));
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "topic-1", expected("topic-1"));
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(0);
});

it.each(["GitLab-only", "remote-less"].flatMap((kind) => ["warm", "cold"].map((cache) => ({ kind, cache }))))(
  "keeps $cache $kind checkouts off the GitHub discovery path until expiry", async ({ kind, cache }) => {
    const cwd = await fixture();
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    onTestFinished(() => { clock.mockRestore(); });
    await readGit(cwd, "remote", "remove", "upstream");
    if (kind === "remote-less") await readGit(cwd, "remote", "remove", "origin");
    else await readGit(cwd, "remote", "set-url", "origin", "https://gitlab.com/fixture/origin.git");
    if (cache === "warm") await resolveGitHubRepoForDirectory(cwd);
    const retryAt = readObservedGitOrigin(cwd)?.retryAt ?? now + 5 * 60_000;
    const resolve = createScheduledPrPrefetchRepoResolver();
    const starts = recordPrefetchStarts();
    for (const branch of topics.slice(0, 3)) await expectEligible(resolve, cwd, branch, []);
    expect(starts.calls).toHaveLength(cache === "warm" ? 0 : 1);
    if (cache === "cold") expect(readObservedGitOrigin(cwd)).toBeUndefined();

    if (kind === "remote-less") await readGit(cwd, "remote", "add", "origin", "https://github.com/fixture/new.git");
    else await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/new.git");
    await remoteHead(cwd, "origin", "main");
    now = retryAt;
    await expectEligible(resolve, cwd, "topic-3", (await oracle(cwd))("topic-3"));
  },
);

it.skipIf(process.platform === "win32").each(["HOME", "XDG_CONFIG_HOME"])(
  "matches Git config resolution when %s traverses a symlink before a parent component", async (name) => {
    const cwd = await fixture();
    const alias = path.join(cwd, "alias");
    const physical = path.join(cwd, "physical");
    const leaf = path.join(physical, "leaf");
    const home = path.join(cwd, "home");
    await mkdir(alias);
    await mkdir(home);
    await mkdir(leaf, { recursive: true });
    await symlink(leaf, path.join(alias, "link"));
    const raw = `${alias}/link/..`;
    const config = name === "HOME" ? path.join(physical, ".gitconfig") : path.join(physical, "git", "config");
    await mkdir(path.dirname(config), { recursive: true });
    vi.stubEnv("GIT_CONFIG_GLOBAL", undefined);
    vi.stubEnv("HOME", name === "HOME" ? raw : home);
    vi.stubEnv("XDG_CONFIG_HOME", name === "XDG_CONFIG_HOME" ? raw : undefined);
    onTestFinished(() => { vi.unstubAllEnvs(); });

    const url = "https://github.com/fixture/origin.git";
    const rewritten = "https://github.com/fixture/rewritten.git";
    expect(await readGit(cwd, "remote", "get-url", "origin")).toBe(url);
    const resolve = createScheduledPrPrefetchRepoResolver();
    await expectEligible(resolve, cwd, "topic-0", (await oracle(cwd))("topic-0"));
    await readGit(cwd, "config", "--file", config, `url.${rewritten}.insteadOf`, url);
    expect(await readGit(cwd, "remote", "get-url", "origin")).toBe(rewritten);
    await expectEligible(resolve, cwd, "topic-1", (await oracle(cwd))("topic-1"));
  },
);

it.skipIf(process.platform === "win32")("expires a verified SSH identity at its original live deadline", async () => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  const config = path.join(cwd, "ssh-result");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), '#!/bin/sh\ncat "$PWRAGENT_TEST_PREFETCH_SSH_CONFIG"\n', { mode: 0o755 });
  await writeFile(config, "hostname github.com\n");
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("PWRAGENT_TEST_PREFETCH_SSH_CONFIG", config);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { vi.unstubAllEnvs(); clock.mockRestore(); });
  for (const remote of ["origin", "upstream"]) {
    await readGit(cwd, "remote", "set-url", remote, `git@fixture-ssh:fixture/${remote}.git`);
  }
  await resolveGitHubRepoForDirectory(cwd);
  const { retryAt } = readObservedGitOrigin(cwd)!;
  now = retryAt - 1;
  const resolve = createScheduledPrPrefetchRepoResolver();
  const ssh = vi.spyOn(gitSubprocessDiagnostics, "start");
  onTestFinished(() => { ssh.mockRestore(); });
  await expectEligible(resolve, cwd, "topic-0", ["https://github.com/fixture/origin.git", "https://github.com/fixture/upstream.git"]);
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config")).toHaveLength(0);
  await writeFile(config, "hostname gitlab.com\n");
  now = retryAt;

  await expectEligible(resolve, cwd, "topic-1", []);
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config")).toHaveLength(1);
});

it.skipIf(process.platform === "win32")("keeps verified SSH metadata aligned with a live owner refresh", async () => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  const config = path.join(cwd, "ssh-result");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), '#!/bin/sh\ncat "$PWRAGENT_TEST_PREFETCH_SSH_CONFIG"\n', { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("PWRAGENT_TEST_PREFETCH_SSH_CONFIG", config);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();

  for (const [index, host] of ["github.com", "github.com", "gitlab.com", "gitlab.com", "github.com"].entries()) {
    await writeFile(config, `hostname ${host}\n`);
    const ownerRepos = await resolveGitHubReposForDirectory(cwd, { fresh: true });
    expect(ownerRepos.map(({ repo }) => repo)).toEqual(host === "github.com" ? ["origin", "upstream"] : ["upstream"]);
    starts.clear();
    await expect(resolve(cwd, topics[index])).resolves.toEqual(ownerRepos);
    // An owner refresh changes the checkout observation only if it changes the identity.
    expect(starts.calls.map(([, args]) => args[0])).toEqual(index === 1 || index === 3
      ? ["for-each-ref"]
      : ["config", "rev-parse", "for-each-ref"]);
  }
});

it.skipIf(process.platform === "win32")("resolves a cold SSH identity once across prefetch and live branch discovery", async () => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nprintf 'hostname github.com\\n'\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await readGit(cwd, "remote", "remove", "upstream");
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  const branches = topics.slice(0, 2);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  const ssh = vi.spyOn(gitSubprocessDiagnostics, "start");
  onTestFinished(() => { ssh.mockRestore(); });
  for (const branch of branches) {
    await expectEligible((directory, head) => resolve(directory, head, branches.length), cwd, branch,
      ["https://github.com/fixture/origin.git"]);
  }
  const fetchAllPullRequestsForBranch = vi.fn(async () => []);
  for (const branch of branches) {
    await detectPullRequestsForThread({ branch, directoryPaths: [cwd], fetcher: { fetchAllPullRequestsForBranch } });
  }

  expect(fetchAllPullRequestsForBranch.mock.calls).toEqual(branches.map((branch) => [{ cwd, branch }]));
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config")).toHaveLength(1);
  expect(starts.calls.filter(([, args]) => args[0] === "config")).toHaveLength(2);
});

it.skipIf(process.platform === "win32").each(["SSH", "native URLs"])("shares %s with live lookup when only the upstream branch is eligible", async (kind) => {
  const cwd = await fixture();
  if (kind === "SSH") {
    const bin = path.join(cwd, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nprintf 'hostname github.com\\n'\n", { mode: 0o755 });
    vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
    onTestFinished(() => { vi.unstubAllEnvs(); });
    await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  } else {
    await readGit(cwd, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  }
  await readGit(cwd, "branch", "--set-upstream-to=upstream/other", "topic-0");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  const ssh = vi.spyOn(gitSubprocessDiagnostics, "start");
  onTestFinished(() => { ssh.mockRestore(); });
  const branches = ["tracks-other", "topic-0"];
  for (const branch of branches) await expectEligible(resolve, cwd, branch, []);
  const fetchAllPullRequestsForBranch = vi.fn(async () => []);
  for (const branch of branches) {
    await detectPullRequestsForThread({ branch, directoryPaths: [cwd], fetcher: { fetchAllPullRequestsForBranch } });
  }

  expect(fetchAllPullRequestsForBranch.mock.calls).toEqual(branches.map(() => [{ cwd, branch: "other" }]));
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config")).toHaveLength(kind === "SSH" ? 1 : 0);
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(kind === "SSH" ? 0 : 2);
});

it.skipIf(process.platform === "win32")("leaves a failed SSH resolution out of the live cache", async () => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  const ssh = path.join(bin, "ssh");
  await mkdir(bin);
  await writeFile(ssh, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  await expectEligible(createScheduledPrPrefetchRepoResolver(), cwd, "topic-0", ["https://github.com/fixture/upstream.git"]);
  expect(readObservedGitOrigin(cwd)).toBeUndefined();

  await writeFile(ssh, "#!/bin/sh\nprintf 'hostname github.com\\n'\n");
  await expect(resolveGitHubRepoForDirectory(cwd)).resolves.toEqual({ host: "github.com", owner: "fixture", repo: "origin" });
});

it.skipIf(process.platform === "win32")("reuses verified config when a remote has no HEAD", async () => {
  const cwd = await fixture();
  const included = path.join(cwd, "included-config");
  await writeFile(included, "[user]\n\tname = Fixture\n");
  await readGit(cwd, "config", "--global", "include.path", included);
  await readGit(cwd, "symbolic-ref", "--delete", "refs/remotes/upstream/HEAD");
  await resolveGitHubRepoForDirectory(cwd);
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of topics.slice(0, 3)) await expectEligible(resolve, cwd, branch, expected(branch));

  const commands = starts.calls.map(([, args]) => args[0]);
  expect(commands.filter((command) => command === "config")).toHaveLength(2);
  expect(commands.filter((command) => command === "symbolic-ref")).toHaveLength(6);
  expect(commands.filter((command) => command === "for-each-ref")).toHaveLength(3);
  expect(commands).toHaveLength(11);
});

it.skipIf(process.platform === "win32").each(["positive", "negative"])("matches Git after an include changes a %s config sample", async (kind) => {
  const cwd = await fixture();
  const included = path.join(cwd, "included-config");
  await writeFile(included, "[user]\n\tname = Fixture\n");
  await readGit(cwd, "config", "--global", "include.path", included);
  await readGit(cwd, "symbolic-ref", "--delete", "refs/remotes/upstream/HEAD");
  const url = kind === "negative" ? "https://gitlab.com/fixture/origin.git" : "https://github.com/fixture/origin.git";
  if (kind === "negative") {
    await readGit(cwd, "remote", "set-url", "origin", url);
    await readGit(cwd, "remote", "set-url", "upstream", "https://gitlab.com/fixture/upstream.git");
  }
  const before = (await oracle(cwd))("topic-0");
  if (kind === "negative") expect(before).toEqual([]);
  const rewritten = "https://github.com/fixture/after-race.git";
  let edited = false;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const answer = await runGitCommand(directory, args, options);
    if (!edited && directory === cwd && args[0] === "config" && args.includes("--show-origin")) {
      edited = true;
      await readGit(cwd, "config", "--file", included, `url.${rewritten}.insteadOf`, url);
    }
    return answer;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const resolve = createScheduledPrPrefetchRepoResolver();
  const actual = await resolve(cwd, "topic-0");
  expect(edited).toBe(true);
  expect(await readGit(cwd, "remote", "get-url", "origin")).toBe(rewritten);
  const expected = (await oracle(cwd))("topic-0");
  expect(expected).not.toEqual(before);
  expect(actual.map(({ host, owner, repo }) => `https://${host}/${owner}/${repo}.git`).sort()).toEqual(expected);
  await expectEligible(resolve, cwd, "topic-1", (await oracle(cwd))("topic-1"));
});

it.skipIf(process.platform === "win32")("uses one current config read per branch with a symlinked include", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "remove", "upstream");
  const included = path.join(cwd, "included-config");
  const urls = ["https://github.com/fixture/first.git", "https://gitlab.com/fixture/other.git", "https://github.com/fixture/last.git"];
  const configs = await Promise.all(urls.map(async (url, index) => {
    const file = path.join(cwd, `included-config-${index}`);
    await readGit(cwd, "config", "--file", file, `url.${url}.insteadOf`, "https://github.com/fixture/origin.git");
    return file;
  }));
  await symlink(configs[0], included);
  await readGit(cwd, "config", "--global", "include.path", included);
  await resolveGitHubRepoForDirectory(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();

  for (const [index, url] of urls.entries()) {
    if (index > 0) {
      await symlink(configs[index], `${included}.next`);
      await rename(`${included}.next`, included);
    }
    const branch = topics[index];
    expect(await readGit(cwd, "remote", "get-url", "origin")).toBe(url);
    const expected = (await oracle(cwd))(branch);
    starts.clear();
    await expectEligible(resolve, cwd, branch, expected);
    // Git config samples the URL, and Git lists the current names before eligibility.
    expect(starts.calls.map(([, args]) => args[0])).toEqual(expected.length
      ? ["config", "remote", "symbolic-ref", "for-each-ref"]
      : ["config"]);
  }
});

it.skipIf(process.platform === "win32").each(["symlinked include", "custom Git"])("rechecks remote names after unverified HTTPS config with %s", async (kind) => {
  const cwd = await fixture();
  const included = path.join(cwd, "included-config");
  const before = path.join(cwd, "before-config");
  const after = path.join(cwd, "after-config");
  const symlinked = kind === "symlinked include";
  if (symlinked) {
    await writeFile(before, "[user]\n\tname = Fixture\n");
    await readGit(cwd, "config", "--file", after, "remote.added.url", "https://github.com/fixture/added.git");
    await readGit(cwd, "config", "--file", after, "remote.added.fetch", "+refs/heads/*:refs/remotes/added/*");
    await symlink(before, included);
    await readGit(cwd, "config", "--local", "include.path", included);
  } else {
    vi.stubEnv("PWRAGENT_GIT_PATH", bundledGitExecutable());
    onTestFinished(() => { vi.unstubAllEnvs(); });
  }
  expect((await oracle(cwd))("release")).toHaveLength(2);

  let changed = false;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const sample = await runGitCommand(directory, args, options);
    if (!changed && directory === cwd && args[0] === "config" && args.includes("--show-origin") === symlinked) {
      changed = true;
      if (symlinked) {
        await symlink(after, `${included}.next`);
        await rename(`${included}.next`, included);
      } else {
        await readGit(cwd, "remote", "add", "added", "https://github.com/fixture/added.git");
      }
      await readGit(cwd, "update-ref", "refs/remotes/added/release", "HEAD");
      await remoteHead(cwd, "added", "release");
    }
    return sample;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const starts = recordPrefetchStarts();
  const resolve = createScheduledPrPrefetchRepoResolver();
  const actual = await resolve(cwd, "release");
  const metadataReads = starts.calls.filter(([, args]) => args[0] === "config" || (args[0] === "remote" && args.length === 1))
    .map(([, args]) => args[0]);

  expect(changed).toBe(true);
  const expected = await oracle(cwd);
  expect(expected("release")).toEqual([]);
  expect(actual).toEqual(expected("release"));
  expect(metadataReads).toEqual(["config", "remote"]);
  expect(readObservedGitOrigin(cwd)).toBeUndefined();

  await expectEligible(resolve, cwd, "topic-0", expected("topic-0"));
  if (!symlinked) {
    expect(readObservedGitOrigin(cwd)).toBeUndefined();
    await resolveGitHubReposForDirectory(cwd);
    starts.clear();
    await expectEligible(resolve, cwd, "topic-1", expected("topic-1"));
    expect(starts.calls.filter(([, args]) => args[0] === "config" || args[0] === "remote").map(([, args]) => args))
      .toEqual([["remote"]]);
  }
});

it.skipIf(process.platform === "win32").each(["matching", "nonmatching"])("keeps the warm launch budget with a %s conditional include", async (kind) => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "remove", "upstream");
  const included = path.join(cwd, "conditional-config");
  const original = "https://github.com/fixture/origin.git";
  const rewritten = "https://github.com/fixture/conditional.git";
  await readGit(cwd, "config", "--file", included, `url.${rewritten}.insteadOf`, original);
  const gitdir = path.join(await fs.realpath(cwd), kind === "matching" ? ".git" : "absent/.git");
  await readGit(cwd, "config", "--global", `includeIf.gitdir:${gitdir}.path`, included);
  expect(await readGit(cwd, "config", "--includes", "--get-regexp", "^includeif\\.")).toContain(included);
  expect(await readGit(cwd, "remote", "get-url", "origin")).toBe(kind === "matching" ? rewritten : original);
  await resolveGitHubRepoForDirectory(cwd);

  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of ["topic-0", "main", "topic-1"]) await expectEligible(resolve, cwd, branch, expected(branch));
  const { rows, startsByCaller } = starts.snapshot();
  expect(startsByCaller).toEqual({
    "pr-scheduled-prefetch": 9, "pr-live-branch-lookup": 0, "pr-stored-attachment-validation": 0,
  });
  expect(Object.fromEntries(rows.map((row) => [`${row.purpose}/${row.command}`, row.started]))).toEqual({
    "pr-remotes/remote-list": 3, "pr-discovery/symbolic-ref": 3, "pr-discovery/refs": 3,
  });

  await remoteHead(cwd, "origin", "release");
  await expectEligible(resolve, cwd, "release", (await oracle(cwd))("release"));
});

it("observes conditional URLs natively before publishing a batch-only identity", async () => {
  const cwd = await fixture();
  const included = path.join(cwd, "branch-config");
  const original = "https://github.com/fixture/origin.git";
  const rewritten = "https://github.com/fixture/conditional.git";
  await readGit(cwd, "config", "--file", included, `url.${rewritten}.insteadOf`, original);
  await readGit(cwd, "config", "--global", "includeIf.onbranch:topic-1.path", included);
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "topic-0", (await oracle(cwd))("topic-0"));
  expect(readObservedGitOrigin(cwd)).toBeUndefined();

  await readGit(cwd, "switch", "topic-1");
  expect(await readGit(cwd, "remote", "get-url", "--all", "origin")).toBe(rewritten);
  const expected = await oracle(cwd);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "topic-1", expected("topic-1"));
  expect(starts.calls.filter(([, args]) => args[0] === "remote" && args[1] === "get-url")).toHaveLength(2);
  await expect(resolveGitHubRepoForDirectory(cwd)).resolves.toEqual({ host: "github.com", owner: "fixture", repo: "conditional" });
  expect(readObservedGitOrigin(cwd)?.repo?.repo).toBe("conditional");

  starts.clear();
  await expectEligible(resolve, cwd, "topic-2", expected("topic-2"));
  expect(starts.calls.filter(([, args]) => args[0] === "remote").map(([, args]) => args)).toEqual([["remote"]]);
});

it.skipIf(process.platform === "win32").each(["symlinked include", "custom Git", "native URLs"])("filters a default branch added during %s SSH fallback", async (kind) => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  const included = path.join(cwd, "included-config");
  const before = path.join(cwd, "before-config");
  const after = path.join(cwd, "after-config");
  if (kind === "symlinked include") {
    await writeFile(before, "[user]\n\tname = Fixture\n");
    await readGit(cwd, "config", "--file", after, "remote.added.url", "https://github.com/fixture/added.git");
    await readGit(cwd, "config", "--file", after, "remote.added.fetch", "+refs/heads/*:refs/remotes/added/*");
    await symlink(before, included);
    await readGit(cwd, "config", "--local", "include.path", included);
  } else if (kind === "native URLs") {
    await readGit(cwd, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  }
  expect((await oracle(cwd))("release")).toEqual(["https://github.com/fixture/upstream.git"]);

  const ssh = await holdSshResolution(cwd);
  if (kind === "custom Git") vi.stubEnv("PWRAGENT_GIT_PATH", bundledGitExecutable());
  const starts = recordPrefetchStarts();
  const scheduled = createScheduledPrPrefetchRepoResolver()(cwd, "release");
  try {
    await Promise.race([ssh.started, scheduled.then(() => { throw new Error("Scheduled lookup did not expand SSH"); })]);
    if (kind === "symlinked include") {
      await symlink(after, `${included}.next`);
      await rename(`${included}.next`, included);
    } else {
      await readGit(cwd, "remote", "add", "added", "https://github.com/fixture/added.git");
    }
    await readGit(cwd, "update-ref", "refs/remotes/added/release", "HEAD");
    await remoteHead(cwd, "added", "release");
  } finally {
    await ssh.release();
    await scheduled;
  }

  const metadataReads = starts.calls.filter(([, args]) => args[0] === "config" || args[0] === "remote" && args.length === 1)
    .map(([, args]) => args[0]);
  const expected = (await oracle(cwd))("release");
  expect(expected).toEqual([]);
  await expect(scheduled).resolves.toEqual(expected);
  expect(metadataReads).toEqual(kind === "native URLs" ? ["config", "remote", "remote"] : ["config", "remote"]);
  expect(readObservedGitOrigin(cwd)).toBeUndefined();
});

it("filters a default branch added during native HTTPS URL probing", async () => {
  const cwd = await fixture();
  await readGit(cwd, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
  expect((await oracle(cwd))("release")).toHaveLength(2);
  const started = Promise.withResolvers<void>();
  const releaseUrl = Promise.withResolvers<void>();
  let holdOrigin = true;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const hold = holdOrigin && directory === cwd && args[0] === "remote" && args[1] === "get-url" && args[3] === "origin";
    const result = await runGitCommand(directory, args, options);
    if (hold) {
      started.resolve();
      await releaseUrl.promise;
    }
    return result;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const starts = recordPrefetchStarts();
  const scheduled = createScheduledPrPrefetchRepoResolver()(cwd, "release");
  try {
    await Promise.race([started.promise, scheduled.then(() => { throw new Error("Scheduled lookup did not read the origin URL"); })]);
    holdOrigin = false;
    await readGit(cwd, "remote", "add", "added", "https://github.com/fixture/added.git");
    await readGit(cwd, "update-ref", "refs/remotes/added/release", "HEAD");
    await remoteHead(cwd, "added", "release");
  } finally {
    releaseUrl.resolve();
    await scheduled;
  }

  const remoteLists = starts.calls.filter(([, args]) => args[0] === "remote" && args.length === 1);
  const expected = (await oracle(cwd))("release");
  expect(expected).toEqual([]);
  await expect(scheduled).resolves.toEqual(expected);
  expect(remoteLists).toHaveLength(2);
  expect(readObservedGitOrigin(cwd)).toBeUndefined();
});

it.skipIf(process.platform === "win32").each([[2, 1], [3, 1], [3, 2]])("uses one config read per branch for %i linked-worktree lookups with %i remotes", async (count, remoteCount) => {
  const source = await fixture();
  await readGit(source, "remote", "remove", "origin");
  await readGit(source, "remote", "remove", "upstream");
  await readGit(source, "config", "extensions.worktreeConfig", "true");
  const cwd = path.join(source, "linked");
  await readGit(source, "worktree", "add", "--detach", cwd);
  for (const remote of ["origin", "upstream"].slice(0, remoteCount)) {
    await readGit(cwd, "config", "--worktree", `remote.${remote}.url`, `https://github.com/fixture/worktree-${remote}.git`);
    await readGit(cwd, "config", "--worktree", `remote.${remote}.fetch`, `+refs/heads/*:refs/remotes/${remote}/*`);
  }
  await readGit(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  await remoteHead(cwd, "origin", "main");
  const included = path.join(source, "included-config");
  const systemConfig = path.join(source, "system-config");
  await writeFile(included, "[user]\n\tname = Fixture\n");
  await readGit(cwd, "config", "--file", systemConfig, "include.path", included);
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "0";
  await resolveGitHubRepoForDirectory(cwd);
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of topics.slice(0, count)) {
    await expectEligible((directory, head) => resolve(directory, head, count), cwd, branch, expected(branch));
  }

  // The first branch checks names natively. Later branches watch the include before reading config.
  const headReads = Array.from({ length: remoteCount }, () => "symbolic-ref");
  expect(starts.calls.map(([, args]) => args[0])).toEqual(
    Array.from({ length: count }, (_, index) => ["config", ...(index === 0 ? ["remote"] : []), ...headReads, "for-each-ref"]).flat(),
  );
  if (remoteCount === 2) {
    await readGit(cwd, "update-ref", "refs/remotes/upstream/release", "HEAD");
    await remoteHead(cwd, "upstream", "release");
    const after = await oracle(cwd);
    starts.clear();
    await expectEligible(resolve, cwd, "release", after("release"));
    await expectEligible(resolve, cwd, "topic-3", after("topic-3"));
    // Once the second HEAD exists, one confirmed observation serves both branches.
    expect(starts.calls.map(([, args]) => args[0])).toEqual([
      "config", "rev-parse", "for-each-ref", "for-each-ref",
    ]);
  }
});

it.skipIf(process.platform === "win32")("tries oversized config provenance once per checkout in a batch", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "remove", "upstream");
  const trackingConfig = Array.from({ length: 600 }, (_, index) =>
    `[branch "tracking-${String(index).padStart(3, "0")}"]\n\tremote = origin\n\tmerge = refs/heads/main\n`).join("");
  await appendFile(path.join(cwd, ".git", "config"), trackingConfig);
  const configArgs = ["--null", "--show-scope", "--includes", "--get-regexp", REMOTE_CONFIG_KEYS];
  const ordinary = await runGitCommand(cwd, ["config", ...configArgs]);
  const withOrigins = await runGitCommand(cwd, ["config", "--show-origin", ...configArgs]);
  expect(Buffer.byteLength(ordinary.stdout)).toBeLessThan(64 * 1024);
  expect(Buffer.byteLength(withOrigins.stdout)).toBeGreaterThan(64 * 1024);
  await resolveGitHubRepoForDirectory(cwd);

  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const [index, branch] of ["topic-0", "main", "topic-1"].entries()) {
    if (index === 2) await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/after-overflow.git");
    const expected = (await oracle(cwd))(branch);
    starts.clear();
    await expectEligible(resolve, cwd, branch, expected);
    // Only the first branch attempts provenance. Each fallback still samples current config.
    expect(starts.calls.filter(([, args]) => args[0] === "config").map(([, args]) => args.includes("--show-origin")))
      .toEqual(index === 0 ? [true, false] : [false]);
  }
  const expectedNextBatch = (await oracle(cwd))("topic-2");
  starts.clear();
  await expectEligible(createScheduledPrPrefetchRepoResolver(), cwd, "topic-2", expectedNextBatch);
  expect(starts.calls.filter(([, args]) => args[0] === "config" && args.includes("--show-origin"))).toHaveLength(1);
});

it.skipIf(process.platform === "win32")("uses native HEAD reads after one rejected checkout proof", async () => {
  const cwd = await fixture("files", "sha256");
  for (const remote of ["origin", "upstream"]) await remoteHead(cwd, remote, "unfetched-default");
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "topic-0", expected("topic-0"));
  expect(starts.calls.map(([, args]) => args[0])).toEqual([
    "config", "rev-parse", "symbolic-ref", "symbolic-ref", "for-each-ref",
  ]);
});

it.skipIf(process.platform === "win32")("keeps two warm single-remote lookups within the ordinary launch count with system config", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "remove", "upstream");
  const systemConfig = path.join(cwd, "system-config");
  await writeFile(systemConfig, "[user]\n\tname = Fixture\n");
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "0";
  await resolveGitHubRepoForDirectory(cwd);
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  for (const branch of topics.slice(0, 2)) {
    await expectEligible((directory, head) => resolve(directory, head, 2), cwd, branch, expected(branch));
  }

  const commands = starts.calls.map(([, args]) => args[0]);
  expect(commands.filter((command) => command === "config")).toHaveLength(2);
  expect(commands.filter((command) => command === "symbolic-ref")).toHaveLength(2);
  expect(commands.filter((command) => command === "for-each-ref")).toHaveLength(2);
  expect(commands).toHaveLength(6);
});

it.skipIf(process.platform === "win32").each([1, 2])("reuses SSH remote discovery for %i configured remotes", async (remoteCount) => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  // OpenSSH alias evaluation is offline and isolated from the operator's config.
  await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nprintf 'hostname github.com\\n'\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  onTestFinished(() => { vi.unstubAllEnvs(); });
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  if (remoteCount === 2) await readGit(cwd, "remote", "set-url", "upstream", "git@fixture-ssh:fixture/upstream.git");
  else await readGit(cwd, "remote", "remove", "upstream");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  const ssh = vi.spyOn(gitSubprocessDiagnostics, "start");
  onTestFinished(() => { ssh.mockRestore(); });
  const expected = ["https://github.com/fixture/origin.git", "https://github.com/fixture/upstream.git"].slice(0, remoteCount);
  for (const branch of topics) await expectEligible(resolve, cwd, branch, expected);

  expect(starts.calls.filter(([, args]) => args[0] === "config").length).toBe(1);
  expect(starts.calls.filter(([, args]) => args[0] === "rev-parse").length).toBe(1);
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config").length).toBe(1);
});

it.skipIf(process.platform === "win32").each(["warm", "cold"])("reuses %s fallback SSH identity while re-reading refs", async (cache) => {
  const cwd = await fixture();
  const bin = path.join(cwd, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "ssh"), "#!/bin/sh\nprintf 'hostname github.com\\n'\n", { mode: 0o755 });
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("PWRAGENT_GIT_PATH", bundledGitExecutable());
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { vi.unstubAllEnvs(); clock.mockRestore(); });
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/origin.git");
  await readGit(cwd, "remote", "remove", "upstream");
  if (cache === "warm") await resolveGitHubRepoForDirectory(cwd);

  const resolve = createScheduledPrPrefetchRepoResolver();
  const starts = recordPrefetchStarts();
  const ssh = vi.spyOn(gitSubprocessDiagnostics, "start");
  onTestFinished(() => { ssh.mockRestore(); });
  await expectEligible(resolve, cwd, "topic-0", ["https://github.com/fixture/origin.git"]);
  await remoteHead(cwd, "origin", "release");
  await expectEligible(resolve, cwd, "release", []);
  await expectEligible(resolve, cwd, "topic-1", ["https://github.com/fixture/origin.git"]);

  const commands = starts.calls.filter(([, , purpose]) => purpose === "pr-remotes" || purpose === "pr-discovery").map(([, args]) => args[0]);
  expect(ssh.mock.calls.filter(([command]) => command === "ssh-config")).toHaveLength(cache === "warm" ? 0 : 1);
  // Warm branches use only the current remote list. The cold branch also discovers identity.
  expect(commands.filter((command) => command === "config" || command === "remote")).toEqual(cache === "warm"
    ? ["remote", "remote", "remote"]
    : ["config", "remote", "remote", "remote"]);
  expect(commands.filter((command) => command === "symbolic-ref")).toHaveLength(3);
  expect(commands.filter((command) => command === "for-each-ref")).toHaveLength(3);
  const { retryAt } = readObservedGitOrigin(cwd)!;
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/renamed.git");
  now = retryAt;
  await expectEligible(resolve, cwd, "topic-2", ["https://github.com/fixture/renamed.git"]);
});

it.skipIf(process.platform === "win32")("reobserves a changed remote HEAD and URL once per checkout observation", async () => {
  const cwd = await fixture();
  const starts = recordPrefetchStarts();
  const resolve = createScheduledPrPrefetchRepoResolver();
  const lookup = async (branches: string[]) => {
    const expected = await oracle(cwd);
    for (const branch of branches) await expectEligible(resolve, cwd, branch, expected(branch));
  };
  await lookup(["release", "topic-0"]);
  await remoteHead(cwd, "origin", "release");
  await lookup(["release", "topic-1"]);
  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/renamed.git");
  await lookup(["release", "topic-2"]);

  expect(starts.calls.filter(([, args, purpose]) => purpose === "pr-remotes" || purpose === "pr-discovery" && args[0] !== "for-each-ref")
    .map(([, args]) => args[0])).toEqual(["config", "rev-parse", "config", "rev-parse", "config", "rev-parse"]);
});

it.each(["bundled", "manually selected"])("rechecks an absent global include when it appears during the batch with %s Git", async (selection) => {
  const cwd = await fixture();
  if (selection === "manually selected") {
    vi.stubEnv("PWRAGENT_GIT_PATH", bundledGitExecutable());
    onTestFinished(() => { vi.unstubAllEnvs(); });
  }
  const included = path.join(cwd, "included-config");
  await runGitCommand(cwd, ["config", "--global", "include.path", included]);
  const resolve = createScheduledPrPrefetchRepoResolver();
  const before = await oracle(cwd);
  await expectEligible(resolve, cwd, "topic-0", before("topic-0"));
  await readGit(cwd, "config", "--file", included, "url.https://github.com/fixture/rewritten.git.insteadOf",
    "https://github.com/fixture/origin.git");
  const after = await oracle(cwd);
  expect(after("topic-1")).not.toEqual(before("topic-0"));
  await expectEligible(resolve, cwd, "topic-1", after("topic-1"));
  await expectEligible(resolve, cwd, "topic-2", after("topic-2"));
});

it("uses checkout-specific config in linked worktrees that share remote refs", async () => {
  const cwd = await fixture();
  const west = path.join(cwd, "west");
  const east = path.join(cwd, "east");
  await readGit(cwd, "config", "extensions.worktreeConfig", "true");
  await readGit(cwd, "worktree", "add", "-b", "west", west);
  await readGit(cwd, "worktree", "add", "-b", "east", east);
  await readGit(west, "config", "--worktree", "remote.origin.url", "https://github.com/fixture/west.git");
  await readGit(east, "config", "--worktree", "remote.origin.url", "https://github.com/fixture/east.git");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const westRepos = (await oracle(west))("topic-0");
  const eastRepos = (await oracle(east))("topic-0");
  expect(westRepos).not.toEqual(eastRepos);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, west, "topic-0", westRepos);
  await expectEligible(resolve, east, "topic-0", eastRepos);
  await expectEligible(resolve, west, "topic-1", westRepos);
  await expectEligible(resolve, east, "topic-1", eastRepos);
  if (process.platform !== "win32") {
    expect(starts.calls.filter(([, args]) => args[0] === "rev-parse").map(([directory]) => directory)).toEqual([west, east]);
  }
});

it("falls back to Git for a packed abbreviation conflict that appears after reuse starts", async () => {
  const cwd = await fixture();
  await remoteHead(cwd, "origin", "release");
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "release", []);
  await readGit(cwd, "update-ref", "refs/tags/origin/release", "HEAD");
  await readGit(cwd, "pack-refs", "--all");
  const expected = (await oracle(cwd))("release");
  expect(expected).toHaveLength(2);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "release", expected);
  expect(starts.calls.some(([, args, purpose]) => purpose === "pr-discovery" && args[0] === "symbolic-ref")).toBe(true);
});

it.each(["bundled", "manually selected"])("keeps fresh eligibility through the Git fallback on reftable with %s Git", async (selection) => {
  const cwd = await fixture("reftable");
  if (selection === "manually selected") {
    vi.stubEnv("PWRAGENT_GIT_PATH", bundledGitExecutable());
    onTestFinished(() => { vi.unstubAllEnvs(); });
  }
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "release", (await oracle(cwd))("release"));
  await remoteHead(cwd, "origin", "release");
  await expectEligible(resolve, cwd, "release", []);
  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/renamed.git");
  await expectEligible(resolve, cwd, "topic-0", (await oracle(cwd))("topic-0"));
});

it("keeps a warm live identity after a scheduled fallback probe fails", async () => {
  const cwd = await fixture("reftable");
  const identity = await resolveGitHubRepoForDirectory(cwd);
  expect(identity).toEqual({ host: "github.com", owner: "fixture", repo: "origin" });
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockRejectedValue(new Error("git remote probe timed out"));
  onTestFinished(() => { runner.mockRestore(); });

  const resolve = createScheduledPrPrefetchRepoResolver();
  await expect(resolve(cwd, "topic-0")).resolves.toEqual([]);
  expect(runner.mock.calls.some(([, , options]) => options?.purpose === "pr-remotes")).toBe(true);
  runner.mockRestore();
  await expect(resolveGitHubRepoForDirectory(cwd)).resolves.toEqual(identity);
  await expectEligible(resolve, cwd, "topic-1", (await oracle(cwd))("topic-1"));
});

it.skipIf(process.platform === "win32")("uses a partial HEAD proof once and observes the missing ref again on the next branch", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "add", "third", "https://github.com/fixture/third.git");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const before = await oracle(cwd);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "topic-0", before("topic-0"));
  await expectEligible(resolve, cwd, "topic-1", before("topic-1"));
  expect(starts.calls.map(([, args]) => args[0])).toEqual([
    "config", "rev-parse", "symbolic-ref", "for-each-ref", "symbolic-ref", "for-each-ref",
  ]);
  await remoteHead(cwd, "third", "release");
  const after = await oracle(cwd);
  expect(after("release")).toEqual([]);
  await expectEligible(resolve, cwd, "release", after("release"));

});

it.skipIf(process.platform === "win32")("stops reusing a checkout when Git rejects its changed ownership", async () => {
  const cwd = await fixture();
  const canonical = await fs.realpath(cwd);
  const { lstat } = await vi.importActual<typeof fs>("node:fs/promises");
  let changed = false;
  // Simulate chown in the filesystem observation and let native Git judge
  // the same ownership transition through its test-only child environment.
  vi.mocked(fs.lstat).mockImplementation((async (...args: Parameters<typeof lstat>) => {
    const stats = await lstat(...args);
    if (changed && args[0] === canonical && typeof stats.uid === "bigint") {
      return Object.assign(stats, { uid: stats.uid + 1n });
    }
    return stats;
  }) as typeof fs.lstat);
  const foreignOwner = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((directory, args, options) =>
    runGitCommand(directory, args, changed && directory === cwd ? { ...options, env: foreignOwner } : options));
  onTestFinished(() => { runner.mockRestore(); vi.mocked(fs.lstat).mockImplementation(lstat); });
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "topic-0", (await oracle(cwd))("topic-0"));
  changed = true;
  await expect(runGitCommand(cwd, ["remote"], { env: foreignOwner })).rejects.toThrow(/dubious ownership/);
  await expectEligible(resolve, cwd, "topic-1", []);
});

it.skipIf(process.platform === "win32")("follows Git when an external object directory disappears between branches", async () => {
  const cwd = await fixture();
  const externalObjects = path.join(cwd, "external-objects");
  const objects = path.join(cwd, ".git", "objects");
  await rename(objects, externalObjects);
  await mkdir(objects);
  process.env.GIT_OBJECT_DIRECTORY = externalObjects;
  const expected = await oracle(cwd);
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "topic-0", expected("topic-0"));

  await rm(externalObjects, { recursive: true, force: true });
  await expect(readGit(cwd, "remote")).rejects.toThrow("not a git repository");
  await expectEligible(resolve, cwd, "topic-1", []);
});

it.skipIf(process.platform === "win32")("discards a remote HEAD observation that changes during checkout verification", async () => {
  const cwd = await fixture();
  let changed = false;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const result = await runGitCommand(directory, args, options);
    if (!changed && args[0] === "rev-parse" && args.includes("--show-ref-format")) {
      changed = true;
      await remoteHead(cwd, "origin", "release");
    }
    return result;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const resolve = createScheduledPrPrefetchRepoResolver();
  await expectEligible(resolve, cwd, "release", []);
  expect(changed).toBe(true);
  const expected = await oracle(cwd);
  await expectEligible(resolve, cwd, "release", expected("release"));
  await expectEligible(resolve, cwd, "topic-0", expected("topic-0"));
});
