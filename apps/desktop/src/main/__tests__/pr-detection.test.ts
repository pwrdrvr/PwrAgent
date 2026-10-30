import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPullRequestsForThread, filterStoredDiscoveredPullRequests } from "../pr-status/pr-detection";
import type { GithubPrFetcher } from "../pr-status/github-pr-fetcher";
import * as gitExecutable from "../app-server/git-executable";
import { resolveForgeReposForDirectory } from "../pr-status/git-remote";

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("detectPullRequestsForThread", () => {
  it.each(["all", "default-refs"])("does not query main when cached remotes survive failed %s git probes", async (failure) => {
    const repo = await createRepoWithDefaultBranch("main");
    await resolveForgeReposForDirectory(repo);
    const runGit = gitExecutable.runGitCommand;
    const runner = vi.spyOn(gitExecutable, "runGitCommand").mockImplementation((cwd, args, options) => {
      if (failure === "default-refs" && args[0] === "remote") return runGit(cwd, args, options);
      return Promise.reject(new Error("git probe timed out"));
    });
    const fetcher = { fetchAllPullRequestsForBranch: vi.fn(async () => []) };
    try {
      await expect(detectPullRequestsForThread({ fetcher, branch: "main", directoryPaths: [repo] }))
        .resolves.toEqual([]);
      expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
    } finally {
      runner.mockRestore();
    }
  });

  it("rejects PRs from unrelated forks with the same head branch and commit", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/shared-name",
      remoteBranch: "fix/shared-name",
    });
    const ownPr = {
      provider: "github.com",
      number: 1,
      org: "ExampleOrg",
      repo: "catalog-service",
      headRefName: "fix/shared-name",
      headSha: "a".repeat(40),
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/1",
    };
    const unrelatedPr = {
      ...ownPr,
      number: 2,
      sourceRepository: { provider: "github.com", org: "unrelated", repo: "catalog-service" },
      url: "https://github.com/ExampleOrg/catalog-service/pull/2",
    };
    const fetcher = { fetchAllPullRequestsForBranch: vi.fn(async () => [unrelatedPr, ownPr]) };

    await expect(detectPullRequestsForThread({
      fetcher,
      branch: "fix/shared-name",
      directoryPaths: [repo],
    })).resolves.toEqual([{ ...ownPr, linkedDirectoryPaths: [repo] }]);
  });

  it("accepts a fork contribution only when its source repository is configured", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/fork-contribution",
      remoteBranch: "fix/fork-contribution",
    });
    await git(repo, "remote", "add", "fork", "git@github.com:contributor/renamed-fork.git");
    const pr = {
      provider: "github.com", number: 3, org: "ExampleOrg", repo: "catalog-service",
      sourceRepository: { provider: "github.com", org: "CONTRIBUTOR", repo: "Renamed-Fork" },
      state: "pending" as const, url: "https://github.com/ExampleOrg/catalog-service/pull/3",
    };
    await expect(detectPullRequestsForThread({
      fetcher: { fetchAllPullRequestsForBranch: vi.fn(async () => [pr]) },
      branch: "fix/fork-contribution", directoryPaths: [repo],
    })).resolves.toEqual([{ ...pr, linkedDirectoryPaths: [repo] }]);
  });

  it("removes legacy default-branch discoveries while preserving explicit PRs and feature history", async () => {
    const repo = await createRepoWithDefaultBranch("main");
    const legacyPr = {
      provider: "github.com", number: 14495, org: "ExampleOrg", repo: "catalog-service",
      headRefName: "main", headSha: "a".repeat(40), state: "merged" as const,
      lifecycleState: "merged" as const,
      sourceRepository: { provider: "github.com", org: "unrelated", repo: "catalog-service" },
      linkedDirectoryPaths: [repo], url: "https://github.com/ExampleOrg/catalog-service/pull/14495",
    };
    const deletedForkPr = { ...legacyPr, number: 12586, sourceRepository: undefined };
    const featurePr = { ...deletedForkPr, number: 4, headRefName: "fix/old-feature" };
    const explicitPr = { ...legacyPr, number: 5, explicitlyAttached: true as const };
    const unavailablePr = { ...legacyPr, number: 6, linkedDirectoryPaths: [path.join(repo, "missing")] };
    const unrelatedFeaturePr = { ...legacyPr, number: 7, headRefName: "fix/shared-name" };
    await expect(filterStoredDiscoveredPullRequests([
      legacyPr, deletedForkPr, featurePr, explicitPr, unavailablePr, unrelatedFeaturePr,
    ])).resolves.toEqual([featurePr, explicitPr, unavailablePr]);
  });

  it("shares stored-attachment probes across threads using the same checkout", async () => {
    const repo = await createRepoWithDefaultBranch("main");
    const pr = {
      provider: "github.com", number: 1, org: "ExampleOrg", repo: "catalog-service", headRefName: "main",
      state: "merged" as const, url: "https://github.com/ExampleOrg/catalog-service/pull/1",
      linkedDirectoryPaths: [repo],
    };
    const runner = vi.spyOn(gitExecutable, "runGitCommand");
    try {
      await expect(filterStoredDiscoveredPullRequests([pr])).resolves.toEqual([]);
      const probeCount = runner.mock.calls.length;
      expect(probeCount).toBeGreaterThan(0);
      await Promise.all(Array.from({ length: 10 }, () => filterStoredDiscoveredPullRequests([pr])));
      expect(runner).toHaveBeenCalledTimes(probeCount);
    } finally {
      runner.mockRestore();
    }
  });

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
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13268",
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

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "search/query-rewrites",
    });
  });

  it("uses the local branch when the tracked remote default is unknown", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/local-feature",
      remoteBranch: "main",
    });
    await git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    await git(repo, "branch", "-D", "main");
    const expectedPr = {
      number: 13269,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13269",
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

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "fix/local-feature",
    });
  });

  it("does not use a descendant ref when the requested local branch is absent", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/descendant",
      remoteBranch: "remote-feature",
    });
    const expectedPr = {
      number: 13271,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13271",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch }) =>
        branch === "fix" ? [expectedPr] : [],
      ),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "fix",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "fix",
    });
  });

  it("does not use another local branch configured as the upstream", async () => {
    const branch = "fix/local-upstream";
    const repo = await createRepoWithBranch(branch);
    await addGitHubRemote(repo);
    await git(repo, "branch", "feature/parent");
    await git(repo, "config", `branch.${branch}.remote`, ".");
    await git(
      repo,
      "config",
      `branch.${branch}.merge`,
      "refs/heads/feature/parent",
    );
    await git(repo, "checkout", branch);
    const expectedPr = {
      number: 13272,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13272",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ branch: lookupBranch }) =>
        lookupBranch === branch ? [expectedPr] : [],
      ),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: [repo],
    });

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch,
    });
  });

  it("uses the local branch when its tracked remote is the default branch", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "fix/local-feature",
      remoteBranch: "main",
    });
    const expectedPr = {
      number: 13269,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13269",
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

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "fix/local-feature",
    });
  });

  it("uses the local branch when it has no upstream", async () => {
    const branch = "fix/untracked-pr";
    const repo = await createRepoWithBranch(branch);
    await addGitHubRemote(repo);
    await git(repo, "checkout", branch);
    const expectedPr = {
      number: 13270,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13270",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => [expectedPr]),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: [repo],
    });

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [repo],
    }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch,
    });
  });

  it("finds a merged PR by the tip commit when the branch was pushed under another name and deleted", async () => {
    const { repo, tip } = await createRepoPushedUnderAnotherName({
      localBranch: "deploy/pinned-gh-374964e",
      pushedBranch: "feat/pinned-gh-runner-readiness",
    });
    const mergedPr = {
      number: 116,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "merged" as const,
      headRefName: "feat/pinned-gh-runner-readiness",
      headSha: tip,
      url: "https://github.com/ExampleOrg/catalog-service/pull/116",
    };
    const fetcher = {
      // The local name never had a PR; the pushed name is not known locally.
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
      fetchPullRequestsForCommit: vi.fn(async ({ sha }: { sha: string }) =>
        sha === tip ? [mergedPr] : []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "deploy/pinned-gh-374964e",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([{ ...mergedPr, linkedDirectoryPaths: [repo] }]);
    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "deploy/pinned-gh-374964e",
    });
    expect(fetcher.fetchPullRequestsForCommit).toHaveBeenCalledWith({ cwd: repo, sha: tip });
  });

  it("does not attach a PR found by commit unless its head is the branch tip", async () => {
    const { repo, tip } = await createRepoPushedUnderAnotherName({
      localBranch: "deploy/stacked",
      pushedBranch: "feat/stacked-base",
    });
    // Someone else's PR built on top of this commit, so GitHub associates it,
    // but its head is a different commit.
    const descendantPr = {
      number: 117,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      headSha: "f".repeat(40),
      url: "https://github.com/ExampleOrg/catalog-service/pull/117",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
      fetchPullRequestsForCommit: vi.fn(async () => [descendantPr]),
    } as unknown as GithubPrFetcher;

    await expect(detectPullRequestsForThread({
      fetcher,
      branch: "deploy/stacked",
      directoryPaths: [repo],
    })).resolves.toEqual([]);
    expect(fetcher.fetchPullRequestsForCommit).toHaveBeenCalledWith({ cwd: repo, sha: tip });
  });

  it("does not look up by commit when the branch name lookup failed", async () => {
    const { repo } = await createRepoPushedUnderAnotherName({
      localBranch: "fix/provider-down",
      pushedBranch: "fix/provider-down-pushed",
    });
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ onProviderFailure }: { onProviderFailure?: () => void }) => {
        onProviderFailure?.();
        return [];
      }),
      fetchPullRequestsForCommit: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;
    const onProviderFailure = vi.fn();

    await detectPullRequestsForThread({
      fetcher,
      branch: "fix/provider-down",
      directoryPaths: [repo],
      onProviderFailure,
    });

    expect(onProviderFailure).toHaveBeenCalledOnce();
    expect(fetcher.fetchPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("does not look up by commit when the branch name already found a PR", async () => {
    const { repo } = await createRepoPushedUnderAnotherName({
      localBranch: "fix/named-pr",
      pushedBranch: "fix/other-name",
    });
    const namedPr = {
      number: 118,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/118",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => [namedPr]),
      fetchPullRequestsForCommit: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    await detectPullRequestsForThread({ fetcher, branch: "fix/named-pr", directoryPaths: [repo] });

    expect(fetcher.fetchPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("does not look up by commit when the branch tip is already on the default branch", async () => {
    // A fresh branch at main's tip would otherwise find whichever PR landed
    // that commit, which belongs to another thread.
    const branch = "fix/fresh-from-main";
    const repo = await createRepoWithDefaultBranch("main");
    await git(repo, "branch", branch, "HEAD");
    await git(repo, "checkout", branch);
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
      fetchPullRequestsForCommit: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    await detectPullRequestsForThread({ fetcher, branch, directoryPaths: [repo] });

    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledOnce();
    expect(fetcher.fetchPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("does not look up by commit when the branch tracks a remote branch", async () => {
    const repo = await createRepoWithRenamedTrackedBranch({
      localBranch: "pr-13269",
      remoteBranch: "search/tracked-rename",
    });
    await git(repo, "commit", "--allow-empty", "-m", "local work");
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
      fetchPullRequestsForCommit: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    await detectPullRequestsForThread({ fetcher, branch: "pr-13269", directoryPaths: [repo] });

    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch: "search/tracked-rename",
    });
    expect(fetcher.fetchPullRequestsForCommit).not.toHaveBeenCalled();
  });

  it("records only the repository that discovered a PR in a multi-repository lookup", async () => {
    const branch = "fix/shared-branch-name";
    const firstRepo = await createRepoWithBranch(branch);
    const secondRepo = await createRepoWithBranch(branch);
    await addGitHubRemote(firstRepo);
    await addGitHubRemote(secondRepo);
    const expectedPr = {
      number: 13273,
      org: "ExampleOrg",
      repo: "catalog-service",
      state: "pending" as const,
      url: "https://github.com/ExampleOrg/catalog-service/pull/13273",
    };
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async ({ cwd }) =>
        cwd === firstRepo ? [expectedPr] : [],
      ),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: [firstRepo, secondRepo],
    });

    expect(prs).toEqual([{
      ...expectedPr,
      linkedDirectoryPaths: [firstRepo],
    }]);
  });

  it("forwards authoritative lookup intent so user refreshes bypass discovery primes", async () => {
    const branch = "fix/authoritative-pr-refresh";
    const repo = await createRepoWithBranch(branch);
    await addGitHubRemote(repo);
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    await detectPullRequestsForThread({
      fetcher,
      branch,
      directoryPaths: [repo],
      allowPrimedBranchLookup: false,
    });

    expect(fetcher.fetchAllPullRequestsForBranch).toHaveBeenCalledWith({
      cwd: repo,
      branch,
      allowPrimed: false,
    });
  });

  it("skips named-branch lookups for invalid directories", async () => {
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
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("skips named-branch lookups for deleted worktree paths", async () => {
    const staleDirectory = await createNonGitDirectory();
    await rm(staleDirectory, { recursive: true, force: true });
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "fix/pr-chip",
      directoryPaths: [staleDirectory],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
  });

  it("skips named-branch lookups for git repositories with no remotes", async () => {
    const repo = await createRepoWithBranch("fix/local-only");
    const fetcher = {
      fetchAllPullRequestsForBranch: vi.fn(async () => []),
    } as unknown as GithubPrFetcher;

    const prs = await detectPullRequestsForThread({
      fetcher,
      branch: "fix/local-only",
      directoryPaths: [repo],
    });

    expect(prs).toEqual([]);
    expect(fetcher.fetchAllPullRequestsForBranch).not.toHaveBeenCalled();
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
  await git(repo, "remote", "set-url", "origin", githubRemoteUrl());
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
  await git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  await git(
    repo,
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  );
  await git(
    repo,
    "branch",
    "--set-upstream-to",
    `origin/${params.remoteBranch}`,
    params.localBranch,
  );
  await git(repo, "checkout", params.localBranch);
  await git(repo, "remote", "set-url", "origin", githubRemoteUrl());
  return repo;
}

/**
 * The PwrSuiteLab case: a local branch with no upstream whose commits were
 * pushed under a different branch name, squash-merged into main, and whose
 * remote branch was then deleted. No remote ref holds the commits any more.
 */
async function createRepoPushedUnderAnotherName(params: {
  localBranch: string;
  pushedBranch: string;
}): Promise<{ repo: string; tip: string }> {
  const repo = await createRepoWithBranch("main");
  const remote = await mkdtemp(
    path.join(tmpdir(), "pwragent-pr-detection-remote-"),
  );
  tempDirs.push(remote);
  await git(remote, "init", "--bare", "-b", "main");
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "main");
  await git(repo, "checkout", "-b", params.localBranch);
  await git(repo, "commit", "--allow-empty", "-m", "first change");
  await git(repo, "commit", "--allow-empty", "-m", "second change");
  const tip = (await git(repo, "rev-parse", "HEAD")).trim();
  await git(repo, "push", "origin", `HEAD:refs/heads/${params.pushedBranch}`);
  await git(repo, "checkout", "main");
  await git(repo, "merge", "--squash", params.localBranch);
  await git(repo, "commit", "--allow-empty", "-m", "squash merge");
  await git(repo, "push", "origin", "main");
  await git(repo, "push", "origin", "--delete", params.pushedBranch);
  await git(repo, "fetch", "--prune", "origin");
  await git(repo, "checkout", params.localBranch);
  // The fixture must match the field case: no upstream, no remote ref.
  expect(await git(repo, "for-each-ref", "--format=%(upstream)", `refs/heads/${params.localBranch}`))
    .toBe("\n");
  expect(await git(repo, "branch", "-r", "--contains", tip)).toBe("");
  await git(repo, "remote", "set-url", "origin", githubRemoteUrl());
  return { repo, tip };
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

async function addGitHubRemote(cwd: string): Promise<void> {
  await git(cwd, "remote", "add", "origin", githubRemoteUrl());
}

function githubRemoteUrl(): string {
  return "git@github.com:ExampleOrg/catalog-service.git";
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
