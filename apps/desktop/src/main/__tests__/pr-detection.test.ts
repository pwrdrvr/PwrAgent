import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import type { GithubPrFetcher } from "../pr-status/github-pr-fetcher";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("detectPullRequestsForThread", () => {
  it("uses local feature branches pointing at detached HEAD", async () => {
    const repo = await createDetachedRepoWithFeatureBranchAtHead(
      "fix/messaging-nonblocking-startup",
    );
    const fetchedBranches: string[] = [];
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) => {
        fetchedBranches.push(branch);
        if (branch !== "fix/messaging-nonblocking-startup") {
          return [];
        }
        return [
          {
            number: 271,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "passing",
            url: `https://github.com/pwrdrvr/PwrAgent/pull/${branch}`,
          },
        ];
      }),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [repo],
    });

    expect(fetchedBranches).toEqual(
      expect.arrayContaining(["fix/messaging-nonblocking-startup"]),
    );
    expect(prs).toHaveLength(1);
  });

  it("does not use detached HEAD at the default branch tip for PR lookup", async () => {
    const repo = await createDetachedRepoAtDefaultBranchTip("main");
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("does not inherit stale PR branches at the default branch tip", async () => {
    const repo = await createDetachedRepoWithDefaultAndStaleBranchAtHead(
      "fix/sidebar-tooltips",
    );
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => [
        {
          number: 317,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "merged",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/317",
        },
      ]),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("does not use an attached default branch for PR lookup", async () => {
    const repo = await createRepoWithDefaultBranch("main");
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "main",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("lets named-branch lookups degrade through the fetcher for invalid directories", async () => {
    const staleDirectory = await createNonGitDirectory();
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => {
        throw new Error("not a git repository");
      }),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "fix/pr-chip",
      directoryPaths: [staleDirectory],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: staleDirectory,
      branch: "fix/pr-chip",
    });
  });

  it("does not reject detached HEAD lookups for invalid directories", async () => {
    const staleDirectory = await createNonGitDirectory();
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [staleDirectory],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("preserves feature branch lookup when fallback default candidates are not at HEAD", async () => {
    const repo = await createDetachedRepoWithDevelopAndFeatureAtHead(
      "fix/detached-feature-pr",
    );
    const fetchedBranches: string[] = [];
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) => {
        fetchedBranches.push(branch);
        if (branch !== "fix/detached-feature-pr") {
          return [];
        }
        return [
          {
            number: 393,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/393",
          },
        ];
      }),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "HEAD",
      directoryPaths: [repo],
    });

    expect(fetchedBranches).toEqual(
      expect.arrayContaining(["develop", "fix/detached-feature-pr"]),
    );
    expect(fetchedBranches).not.toEqual(["develop"]);
    expect(prs).toHaveLength(1);
  });
});

async function createDetachedRepoWithFeatureBranchAtHead(
  branch: string,
): Promise<string> {
  const repo = await createRepoWithBranch(branch);
  await git(repo, "commit", "--allow-empty", "-m", "move main forward");
  await git(repo, "checkout", "--detach", branch);
  return repo;
}

async function createDetachedRepoAtDefaultBranchTip(
  branch: string,
): Promise<string> {
  const repo = await createRepoWithDefaultBranch(branch);
  await git(repo, "checkout", "--detach", "HEAD");
  return repo;
}

async function createDetachedRepoWithDefaultAndStaleBranchAtHead(
  branch: string,
): Promise<string> {
  const repo = await createRepoWithDefaultBranch("main");
  await git(repo, "branch", branch, "HEAD");
  await git(repo, "checkout", "--detach", "HEAD");
  return repo;
}

async function createDetachedRepoWithDevelopAndFeatureAtHead(
  branch: string,
): Promise<string> {
  const repo = await createRepoWithBranch(branch);
  await git(repo, "branch", "develop", branch);
  await git(repo, "commit", "--allow-empty", "-m", "move main forward");
  await git(repo, "checkout", "--detach", branch);
  return repo;
}

async function createRepoWithDefaultBranch(branch: string): Promise<string> {
  const repo = await createRepoWithBranch(branch);
  const remote = await mkdtemp(
    path.join(tmpdir(), "pwragent-pr-detection-remote-"),
  );
  tempDirs.push(remote);
  await git(remote, "init", "--bare");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
  await git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    `refs/remotes/origin/${branch}`,
  );
  await git(repo, "branch", "--set-upstream-to", `origin/${branch}`, branch);
  return repo;
}

async function createRepoWithBranch(branch: string): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), "pwragent-pr-detection-"));
  tempDirs.push(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "PwrAgent Test");
  await git(repo, "commit", "--allow-empty", "-m", "initial");
  const sha = (await git(repo, "rev-parse", "HEAD")).trim();
  if (!(await branchExists(repo, branch))) {
    await git(repo, "branch", branch, sha);
  }
  return repo;
}

async function createNonGitDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "pwragent-pr-detection-"));
  tempDirs.push(directory);
  await mkdir(path.join(directory, "nested"));
  return directory;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await git(cwd, "rev-parse", "--verify", branch);
    return true;
  } catch {
    return false;
  }
}
