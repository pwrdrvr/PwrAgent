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
  it("does not use local feature branches pointing at detached HEAD", async () => {
    const repo = await createDetachedRepoWithFeatureBranchAtHead(
      "fix/messaging-nonblocking-startup",
    );
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

  it("uses the tracked remote branch when the local branch was renamed", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "pr-13268",
      remoteBranch: "search/query-rewrites",
    });
    const expectedPr = {
      number: 13268,
      org: "Giphy",
      repo: "giphy-services",
      state: "pending" as const,
      url: "https://github.com/Giphy/giphy-services/pull/13268",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) =>
        branch === "search/query-rewrites" ? [expectedPr] : [],
      ),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "pr-13268",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([expectedPr]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "search/query-rewrites",
    });
  });

  it("uses the local branch when its tracked remote is the default branch", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/local-feature",
      remoteBranch: "main",
    });
    const expectedPr = {
      number: 13269,
      org: "Giphy",
      repo: "giphy-services",
      state: "pending" as const,
      url: "https://github.com/Giphy/giphy-services/pull/13269",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) =>
        branch === "fix/local-feature" ? [expectedPr] : [],
      ),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "fix/local-feature",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([expectedPr]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "fix/local-feature",
    });
  });

  it("uses the local branch when it has no upstream", async () => {
    const branch = "fix/untracked-pr";
    const repo = await createRepoWithBranch(branch);
    await git(repo, "checkout", branch);
    const expectedPr = {
      number: 13270,
      org: "Giphy",
      repo: "giphy-services",
      state: "pending" as const,
      url: "https://github.com/Giphy/giphy-services/pull/13270",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => [expectedPr]),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: [repo],
    });

    expect(prs).toEqual([expectedPr]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch,
    });
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

  it("does not infer PR lookup branches for detached HEAD even when feature branches point at it", async () => {
    const repo = await createDetachedRepoWithDevelopAndFeatureAtHead(
      "fix/detached-feature-pr",
    );
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

async function createRepoWithRenamedTrackedBranch(params: {
  localBranch: string;
  remoteBranch: string;
}): Promise<string> {
  const repo = await createRepoWithBranch(params.localBranch);
  const remote = await mkdtemp(
    path.join(tmpdir(), "pwragent-pr-detection-remote-"),
  );
  tempDirs.push(remote);
  await git(remote, "init", "--bare");
  await git(repo, "remote", "add", "origin", remote);
  await git(
    repo,
    "update-ref",
    `refs/remotes/origin/${params.remoteBranch}`,
    "HEAD",
  );
  await git(
    repo,
    "branch",
    "--set-upstream-to",
    `origin/${params.remoteBranch}`,
    params.localBranch,
  );
  await git(repo, "checkout", params.localBranch);
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
