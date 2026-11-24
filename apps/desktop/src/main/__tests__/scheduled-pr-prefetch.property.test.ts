import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { bundledGitExecutable } from "../bundled-git";
import { GitSubprocessDiagnostics, gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, readObservedGitOrigin, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
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
  const metadata = process.platform === "win32" ? ["config"] : ["config", "rev-parse"];
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
  expect(commands.filter((command) => command === "remote")).toHaveLength(3);
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
    // Each branch sees the current include target through one Git config read.
    expect(starts.calls.map(([, args]) => args[0])).toEqual(expected.length
      ? ["config", "symbolic-ref", "for-each-ref"]
      : ["config"]);
  }
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
  onTestFinished(() => { vi.unstubAllEnvs(); });
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
  // Each fallback samples config instead of listing remote names separately.
  expect(commands.filter((command) => command === "config" || command === "remote")).toHaveLength(3);
  expect(commands.filter((command) => command === "symbolic-ref")).toHaveLength(3);
  expect(commands.filter((command) => command === "for-each-ref")).toHaveLength(3);
  await readGit(cwd, "remote", "set-url", "origin", "git@fixture-ssh:fixture/renamed.git");
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

it("rechecks an absent global include when it appears during the batch", async () => {
  const cwd = await fixture();
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

it("keeps fresh eligibility through the Git fallback on reftable", async () => {
  const cwd = await fixture("reftable");
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
