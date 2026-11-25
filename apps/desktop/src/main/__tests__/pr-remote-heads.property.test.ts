import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import * as gitExecutable from "../app-server/git-executable";
import { gitSubprocessDiagnostics } from "../diagnostics/git-subprocess-diagnostics";
import { createStoredAttachmentObservation, filterStoredDiscoveredPullRequests, type PrAttachmentDemand } from "../pr-status/pr-detection";
import { clearGitHubRemoteCache } from "../pr-status/git-remote";
import { readGitRemoteHead, readProvenRemoteHeads } from "../pr-status/pr-remote-heads";
import { PR_METADATA_PRIORITY, runPrMetadataGit, runPrMetadataProcess } from "../pr-status/pr-metadata-process";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

const run = gitExecutable.runGitCommand;
const git = async (cwd: string, ...args: string[]) => (await run(cwd, args)).stdout.trim();
const setRemoteHead = (cwd: string, remote: string, target: string) =>
  git(cwd, "symbolic-ref", `refs/remotes/${remote}/HEAD`, target);

async function fixture(refFormat: "files" | "reftable" = "files") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-remote-heads-"));
  const restoreEnv = isolateProcessGitEnvironment(root);
  onTestFinished(async () => {
    restoreEnv();
    clearGitHubRemoteCache();
    await rm(root, { recursive: true, force: true });
  });
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await git(repository, "init", "-b", "main", `--ref-format=${refFormat}`, "--object-format=sha1");
  await git(repository, "-c", "commit.gpgsign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  await git(repository, "remote", "add", "origin", "https://github.com/fixture/project.git");
  await git(repository, "config", "extensions.worktreeConfig", "true");
  const checkouts = ["east", "west"].map((name) => ({
    cwd: path.join(root, name),
    remote: name,
  }));
  for (const { cwd, remote } of checkouts) {
    await git(repository, "worktree", "add", "-b", remote, cwd);
    await git(cwd, "config", "--worktree", `remote.${remote}.url`, `https://github.com/fixture/${remote}.git`);
    await setRemoteHead(repository, remote, `refs/remotes/${remote}/default/${remote}`);
  }
  await git(repository, "update-ref", "refs/remotes/origin/first", "HEAD");
  await setRemoteHead(repository, "origin", "refs/remotes/origin/first");
  return { repository, checkouts };
}

async function observeGit(cwd: string) {
  const names = (await git(cwd, "remote")).split("\n").filter(Boolean);
  const heads = new Map<string, string>();
  for (const name of names) {
    const head = await git(cwd, "symbolic-ref", "--quiet", "--short", `refs/remotes/${name}/HEAD`).catch(() => "");
    if (head.startsWith(name + "/")) heads.set(name, head);
  }
  return { names, heads };
}

async function expectDiscoveryMatchesGit(prs: PrSummary[], demand?: PrAttachmentDemand) {
  const kept: PrSummary[] = [];
  for (const cwd of new Set(prs.map((pr) => pr.linkedDirectoryPaths![0]!))) {
    const { heads, names } = await observeGit(cwd);
    const defaults = new Set([...heads].map(([remote, head]) => head.slice(remote.length + 1)));
    if (!defaults.size) {
      const refs = (await git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads/main", "refs/heads/master", "refs/heads/develop", "refs/heads/trunk")).split("\n");
      const fallback = ["main", "master", "develop", "trunk"].find((branch) => refs.includes("refs/heads/" + branch));
      if (fallback) defaults.add(fallback);
    }
    const fetchUrls = (await Promise.all(names.map((name) => git(cwd, "remote", "get-url", "--all", name)))).flatMap((urls) => urls.split("\n"));
    kept.push(...prs.filter((pr) => pr.linkedDirectoryPaths![0] === cwd
      && !defaults.has(pr.headRefName!)
      && fetchUrls.includes(`https://github.com/${pr.org}/${pr.repo}.git`)));
  }
  expect(await filterStoredDiscoveredPullRequests(prs, { demand })).toEqual(kept);
  return kept;
}

function attachments(checkouts: { cwd: string }[]) {
  return checkouts.flatMap(({ cwd }, index) =>
    ["first", "second", "default/east", "default/west", "default/renamed", "main", "topic"]
      .flatMap((branch, branchIndex) => ["fixture", "other"].map((org, sourceIndex): PrSummary => {
        const number = index * 100 + branchIndex * 2 + sourceIndex + 1;
        return {
          provider: "github.com", org, repo: "project", number, state: "merged", headRefName: branch,
          url: `https://github.com/${org}/project/pull/${number}`, linkedDirectoryPaths: [cwd],
        };
      })));
}

it("matches Git as shared HEADs and worktree-specific remotes change across both refresh windows", async () => {
  const { repository, checkouts } = await fixture();
  const prs = attachments(checkouts);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  const initial = await expectDiscoveryMatchesGit(prs);
  const originPrs = prs.filter((pr) => pr.org === "fixture");
  const east = checkouts[0]!.cwd;
  const west = checkouts[1]!.cwd;
  await git(repository, "pack-refs", "--all");
  await git(repository, "symbolic-ref", "refs/remotes/origin/alias", "refs/remotes/origin/second");
  await setRemoteHead(repository, "origin", "refs/remotes/origin/alias");
  await git(east, "config", "--worktree", "--remove-section", "remote.east");
  await git(east, "config", "--worktree", "remote.renamed.url", "https://github.com/fixture/renamed.git");
  await setRemoteHead(repository, "renamed", "refs/remotes/renamed/default/renamed");

  expect(await filterStoredDiscoveredPullRequests(prs)).toEqual(initial);
  now += 60_001;
  await expectDiscoveryMatchesGit(originPrs);
  for (const { cwd } of checkouts) {
    const { names, heads } = await observeGit(cwd);
    expect(await readProvenRemoteHeads(cwd, names)).toEqual(process.platform === "win32" ? undefined : heads);
  }

  await git(east, "config", "--worktree", "remote.origin.url", "https://github.com/other/project.git");
  now += 300_001;
  await expectDiscoveryMatchesGit(prs);

  // Packed tags and worktree-local refs can change Git's answer with the
  // same common directory and the same raw remote HEAD.
  await git(repository, "update-ref", "refs/tags/origin/second", "HEAD");
  await git(repository, "pack-refs", "--all");
  expect((await observeGit(east)).heads.has("origin")).toBe(false);
  now += 60_001;
  await expectDiscoveryMatchesGit(prs);

  await git(repository, "update-ref", "-d", "refs/tags/origin/second");
  await setRemoteHead(repository, "origin", "refs/bisect/bridge");
  await git(east, "symbolic-ref", "refs/bisect/bridge", "refs/remotes/origin/first");
  await git(west, "symbolic-ref", "refs/bisect/bridge", "refs/remotes/origin/second");
  expect((await observeGit(east)).heads.get("origin")).toBe("origin/first");
  expect((await observeGit(west)).heads.get("origin")).toBe("origin/second");
  now += 60_001;
  await expectDiscoveryMatchesGit(prs);

  const gitDir = await git(repository, "rev-parse", "--absolute-git-dir");
  process.env.GIT_DIR = gitDir;
  expect(await readProvenRemoteHeads(east, ["origin", "renamed"])).toBeUndefined();
  now += 300_001;
  await expectDiscoveryMatchesGit(prs);
}, 15_000);

it("uses per-checkout Git when a shared remote HEAD traverses worktree-private refs", async () => {
  const { repository, checkouts } = await fixture();
  const [east, west] = checkouts.map(({ cwd }) => cwd);
  const members = new Map<string, string>();
  for (const { cwd, remote } of checkouts) {
    await git(cwd, "config", "--worktree", "--remove-section", `remote.${remote}`);
    const gitDir = await git(cwd, "rev-parse", "--absolute-git-dir");
    await rm(path.join(gitDir, "config.worktree"), { force: true });
    members.set(cwd, gitDir);
  }
  await git(repository, "update-ref", "refs/remotes/origin/second", "HEAD");
  const read = () => expectDiscoveryMatchesGit(attachments(checkouts), {
    storedAttachmentObservation: createStoredAttachmentObservation(async (cwd) => {
      const gitDir = members.get(cwd);
      return gitDir ? { root: east!, gitDir, remoteCandidates: ["origin"] } : undefined;
    }),
  });
  await read();
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_001);
  onTestFinished(() => { clock.mockRestore(); });
  await setRemoteHead(repository, "origin", "refs/bisect/bridge");
  await git(east!, "symbolic-ref", "refs/bisect/bridge", "refs/remotes/origin/first");
  await git(west!, "symbolic-ref", "refs/bisect/bridge", "refs/remotes/origin/second");
  const exact = await read();
  expect(exact.some((pr) => pr.linkedDirectoryPaths?.[0] === east && pr.headRefName === "second")).toBe(true);
  expect(exact.some((pr) => pr.linkedDirectoryPaths?.[0] === west && pr.headRefName === "first")).toBe(true);
});

it("uses Git's reftable answers", async () => {
  const table = await fixture("reftable");
  for (const { cwd } of table.checkouts) {
    expect(await git(cwd, "rev-parse", "--show-ref-format")).toBe("reftable");
    expect(await readProvenRemoteHeads(cwd, (await observeGit(cwd)).names)).toBeUndefined();
  }
  await expectDiscoveryMatchesGit(attachments(table.checkouts));
}, 15_000);

it("uses Git for malformed loose symrefs", async () => {
  const files = await fixture();
  const looseHead = path.join(files.repository, ".git", "refs", "remotes", "origin", "HEAD");
  await writeFile(looseHead, "ref: invalid ..\n");
  const cwd = files.checkouts[0]!.cwd;
  expect(await readProvenRemoteHeads(cwd, (await observeGit(cwd)).names)).toBeUndefined();
  await expectDiscoveryMatchesGit(attachments(files.checkouts));
}, 15_000);

it("re-reads Git if a remote HEAD changes after an earlier probe starts", async () => {
  const { repository } = await fixture();
  const observed = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let starts = 0;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (cwd, args, options) => {
    const first = args[0] === "symbolic-ref" && ++starts === 1;
    const answer = await run(cwd, args, options);
    if (first) {
      observed.resolve();
      await release.promise;
    }
    return answer;
  });
  const earlier = readGitRemoteHead(repository, "origin");
  try {
    await Promise.race([observed.promise, earlier]);
    await setRemoteHead(repository, "origin", "refs/remotes/origin/second");
    expect(await readGitRemoteHead(repository, "origin")).toBe("origin/second");
    release.resolve();
    expect(await earlier).toBe("origin/first");
    expect(starts).toBe(2);
  } finally {
    release.resolve();
    await earlier;
    runner.mockRestore();
  }
}, 15_000);

it("keeps queued remote HEAD probes scoped to their environment and live readers", async () => {
  const { repository } = await fixture();
  const redirectedGitDir = path.join(path.dirname(repository), "redirect.git");
  await git(repository, "init", "--bare", redirectedGitDir);
  await setRemoteHead(redirectedGitDir, "origin", "refs/remotes/origin/redirected");

  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let active = 0;
  const blockers = Array.from({ length: 8 }, () => runPrMetadataProcess(async () => {
    if (++active === 8) ready.resolve();
    await release.promise;
  }));
  await ready.promise;
  const cancelled = new AbortController();
  const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  const initial = readGitRemoteHead(repository, "origin", { signal: cancelled.signal });
  const retained = readGitRemoteHead(repository, "origin");
  const abandoned = readGitRemoteHead(repository, "abandoned", { signal: cancelled.signal });
  process.env.GIT_DIR = redirectedGitDir;
  const redirected = readGitRemoteHead(repository, "origin");
  try {
    cancelled.abort();
    await expect(initial).rejects.toMatchObject({ name: "AbortError" });
    await expect(abandoned).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    expect(await Promise.all([retained, redirected])).toEqual(["origin/first", "origin/redirected"]);
    expect(launches.mock.calls.map(([, args]) => args[3])).toEqual(Array(2).fill("refs/remotes/origin/HEAD"));
  } finally {
    cancelled.abort();
    release.resolve();
    await Promise.allSettled([...blockers, initial, retained, abandoned, redirected]);
    launches.mockRestore();
  }
}, 15_000);

it.skipIf(process.platform === "win32")("falls back to Git when a ref changes during checkout verification", async () => {
  const { repository, checkouts } = await fixture();
  const cwd = checkouts[0]!.cwd;
  const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation(async (directory, args, options) => {
    const result = await run(directory, args, options);
    if (directory === cwd && args.includes("--show-ref-format")) {
      await setRemoteHead(repository, "origin", "refs/remotes/origin/second");
    }
    return result;
  });
  onTestFinished(() => { runner.mockRestore(); });
  const prs = attachments([checkouts[0]!]).filter((pr) => pr.org === "fixture");
  const retained = await filterStoredDiscoveredPullRequests(prs);
  // Git has moved the default by the time the probe returns. The old answer
  // would suppress first and retain second. The fallback must see the edit.
  expect(retained.map((pr) => pr.headRefName)).toEqual(["first", "default/west", "default/renamed", "main", "topic"]);
  expect(runner.mock.calls.filter(([, args]) => args.includes("--show-ref-format"))).toHaveLength(1);
  expect(runner.mock.calls.filter(([, args]) => args[0] === "symbolic-ref" && args[1] === "--quiet")).toHaveLength(2);
});

it.skipIf(process.platform === "win32")("promotes a late selected reader through the default-ref refresh", async () => {
  const { repository, checkouts } = await fixture();
  const cwd = checkouts[0]!.cwd;
  const prs = attachments([checkouts[0]!]).filter((pr) => pr.org === "fixture");
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  onTestFinished(() => { clock.mockRestore(); });
  const expected = await expectDiscoveryMatchesGit(prs);
  now += 60_001;

  let release!: () => void;
  let ready!: () => void;
  let active = 0;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const full = new Promise<void>((resolve) => { ready = resolve; });
  const blockers = Array.from({ length: 8 }, () => runPrMetadataProcess(async () => {
    if (++active === 8) ready();
    await hold;
  }));
  await full;

  const launches = vi.spyOn(gitSubprocessDiagnostics, "startGit");
  onTestFinished(() => { launches.mockRestore(); });
  const background = Array.from({ length: 32 }, () => runPrMetadataGit(repository, ["rev-parse", "HEAD"], { purpose: "pr-discovery" }));
  const coldRead = filterStoredDiscoveredPullRequests(prs);
  // Give the low-priority read time to queue its first Git command, then join
  // that same observation as the selected reader while the slots are full.
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  const selected = filterStoredDiscoveredPullRequests(prs, {
    demand: { priority: () => PR_METADATA_PRIORITY.selected },
  });
  release();
  await Promise.all([...blockers, ...background]);
  expect(await Promise.all([coldRead, selected])).toEqual([expected, expected]);
  const commands = launches.mock.calls;
  expect(commands[0]?.slice(0, 2)).toEqual([cwd, ["remote"]]);
  expect(commands.filter(([directory]) => directory === cwd).map(([, args]) => args[0])).toEqual(["remote", "rev-parse"]);
}, 15_000);
