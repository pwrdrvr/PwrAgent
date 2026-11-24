import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { expect, it, onTestFinished, vi } from "vitest";
import * as gitExecutable from "../app-server/git-executable";
import { bundledGitExecutable } from "../bundled-git";
import { GitSubprocessDiagnostics, gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { clearGitHubRemoteCache, resolveGitHubRepoForDirectory } from "../pr-status/git-remote";
import { createScheduledPrPrefetchRepoResolver } from "../pr-status/pr-detection";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

const runGitCommand = gitExecutable.runGitCommand;
const readGit = async (cwd: string, ...args: string[]) => (await runGitCommand(cwd, args)).stdout.trim();
const topics = Array.from({ length: 12 }, (_, index) => `topic-${index}`);
const remoteHead = (cwd: string, remote: string, branch: string) =>
  readGit(cwd, "symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${branch}`);

async function fixture(refFormat = "files") {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pwragent-scheduled-pr-prefetch-"));
  const restoreEnv = isolateProcessGitEnvironment(cwd);
  onTestFinished(async () => {
    restoreEnv();
    clearGitHubRemoteCache();
    await rm(cwd, { recursive: true, force: true });
  });
  await readGit(cwd, "init", "-b", "main", `--ref-format=${refFormat}`, "--object-format=sha1");
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

it.each(["warm", "cold"])("avoids repeated URL probes in a %s single-branch clone", async (cache) => {
  const source = await fixture();
  const cwd = path.join(source, "single-branch");
  await readGit(source, "clone", "--single-branch", "--branch", "main", "--", source, cwd);
  await readGit(cwd, "remote", "set-url", "origin", "https://github.com/fixture/single-branch.git");
  await remoteHead(cwd, "origin", "main");
  const branches = topics.slice(0, 3);
  for (const branch of branches) await readGit(cwd, "branch", branch);
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

  expect(starts.calls.map(([, args]) => args[0])).toEqual([
    "config", "symbolic-ref", "for-each-ref", "config", "symbolic-ref", "for-each-ref",
  ]);
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

  await expect(createScheduledPrPrefetchRepoResolver()(cwd, "topic-0")).resolves.toEqual([]);
  expect(runner.mock.calls.some(([, , options]) => options?.purpose === "pr-remotes")).toBe(true);
  runner.mockRestore();
  await expect(resolveGitHubRepoForDirectory(cwd)).resolves.toEqual(identity);
});

it.skipIf(process.platform === "win32")("uses a partial HEAD proof once and observes the missing ref again on the next branch", async () => {
  const cwd = await fixture();
  await readGit(cwd, "remote", "add", "third", "https://github.com/fixture/third.git");
  const resolve = createScheduledPrPrefetchRepoResolver();
  const before = await oracle(cwd);
  const starts = recordPrefetchStarts();
  await expectEligible(resolve, cwd, "topic-0", before("topic-0"));
  const firstCommands = starts.calls.map(([, args]) => args[0]);
  await remoteHead(cwd, "third", "release");
  const after = await oracle(cwd);
  expect(after("release")).toEqual([]);
  await expectEligible(resolve, cwd, "release", after("release"));

  expect(firstCommands).toEqual(["config", "rev-parse", "symbolic-ref", "for-each-ref"]);
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
