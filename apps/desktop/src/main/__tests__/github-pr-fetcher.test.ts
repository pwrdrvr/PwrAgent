import { describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import {
  GithubPrFetcher,
  deriveChipState,
  deriveLifecycleState,
  deriveMergeState,
  deriveReviewState,
  hasChecksStillRunning,
  parseGhAuthStatus,
  parseGhPrPayload,
} from "../pr-status/github-pr-fetcher";

// JSON shape pinned from `gh pr list --json …` against pwrdrvr/PwrAgent
// running gh 2.88.1 on 2026-05-04. If gh changes the shape, update these
// fixtures FIRST so the failure is loud and obvious.
function rawMergedPr() {
  return {
    number: 178,
    title: "Retain thread pull request history",
    url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
    state: "MERGED",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    mergedAt: "2026-05-05T00:06:31Z",
    commits: [
      { oid: "a".repeat(40) },
      { oid: "b".repeat(40) },
    ],
    baseRefName: "agent/github-pr-auto-fix-settings",
    headRefName: "feat/desktop-thread-reactions-and-pr-chips",
    headRepository: { name: "PwrAgent" },
    headRepositoryOwner: { login: "pwrdrvr" },
    statusCheckRollup: [
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        status: "COMPLETED",
        name: "Lint",
      },
    ],
  };
}

describe("parseGhPrPayload", () => {
  it("maps the pinned JSON shape into a PrSummary", () => {
    expect(parseGhPrPayload(rawMergedPr())).toEqual({
      provider: "github.com",
      number: 178,
      org: "pwrdrvr",
      repo: "PwrAgent",
      title: "Retain thread pull request history",
      baseRefName: "agent/github-pr-auto-fix-settings",
      headRefName: "feat/desktop-thread-reactions-and-pr-chips",
      state: "passing",
      checkState: "passing",
      lifecycleState: "merged",
      reviewState: "ready_for_review",
      mergeState: "unknown",
      headSha: "b".repeat(40),
      commitShas: ["a".repeat(40), "b".repeat(40)],
      url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
    });
  });

  it("omits blank titles from PrSummary", () => {
    expect(parseGhPrPayload({ ...rawMergedPr(), title: " " })).not.toHaveProperty(
      "title",
    );
  });

  it("falls back to empty strings for missing repo/owner", () => {
    const summary = parseGhPrPayload({
      ...rawMergedPr(),
      headRepository: null,
      headRepositoryOwner: null,
    });
    expect(summary.org).toBe("");
    expect(summary.repo).toBe("");
  });

  it("retains the first safe failed-check destination", () => {
    const summary = parseGhPrPayload({
      ...rawMergedPr(),
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/pwrdrvr/PwrAgent/actions/runs/123",
          status: "COMPLETED",
        },
      ],
    });

    expect(summary.failedCheckUrl).toBe(
      "https://github.com/pwrdrvr/PwrAgent/actions/runs/123",
    );
  });

  it("retains loopback HTTP failed-check destinations", () => {
    const summary = parseGhPrPayload({
      ...rawMergedPr(),
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          detailsUrl: "http://localhost:3000/runs/123",
          status: "COMPLETED",
        },
      ],
    });

    expect(summary.failedCheckUrl).toBe("http://localhost:3000/runs/123");
  });

  it("rejects remote HTTP failed-check destinations", () => {
    const summary = parseGhPrPayload({
      ...rawMergedPr(),
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          detailsUrl: "http://ci.example.com/runs/123",
          status: "COMPLETED",
        },
      ],
    });

    expect(summary).not.toHaveProperty("failedCheckUrl");
  });
});

describe("derive PR states", () => {
  it("keeps lifecycle separate from check state", () => {
    const row = { ...rawMergedPr(), state: "MERGED" };
    expect(deriveLifecycleState(row)).toBe("merged");
    expect(deriveChipState(row)).toBe("passing");
  });

  it("keeps closed lifecycle separate from check state", () => {
    const row = {
      ...rawMergedPr(),
      state: "CLOSED",
      mergedAt: null,
    };
    expect(deriveLifecycleState(row)).toBe("closed");
    expect(deriveChipState(row)).toBe("passing");
  });

  it("keeps draft review state separate from check state", () => {
    const row = {
      ...rawMergedPr(),
      state: "OPEN",
      isDraft: true,
    };
    expect(deriveReviewState(row)).toBe("draft");
    expect(deriveChipState(row)).toBe("passing");
  });

  it("detects merge conflicts separately from check state", () => {
    const row = {
      ...rawMergedPr(),
      state: "OPEN",
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    };
    expect(deriveMergeState(row)).toBe("conflicting");
    expect(deriveChipState(row)).toBe("passing");
  });

  it("returns passing when all checks SUCCEEDED", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            name: "Lint",
          },
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            name: "Test",
          },
        ],
      }),
    ).toBe("passing");
  });

  it("returns passing when checks include SKIPPED / NEUTRAL", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            name: "Lint",
          },
          {
            __typename: "CheckRun",
            conclusion: "SKIPPED",
            status: "COMPLETED",
            name: "Optional",
          },
        ],
      }),
    ).toBe("passing");
  });

  it("treats a successful conclusion as final even when gh reports stale progress status", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "IN_PROGRESS",
            name: "Install Dependencies",
          },
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            name: "Test",
          },
        ],
      }),
    ).toBe("passing");
  });

  it("returns failing when any check FAILED / CANCELLED / TIMED_OUT", () => {
    for (const conclusion of ["FAILURE", "CANCELLED", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED"]) {
      expect(
        deriveChipState({
          ...rawMergedPr(),
          state: "OPEN",
          statusCheckRollup: [
            {
              __typename: "CheckRun",
              conclusion: "SUCCESS",
              status: "COMPLETED",
              name: "Lint",
            },
            {
              __typename: "CheckRun",
              conclusion,
              status: "COMPLETED",
              name: "Bad",
            },
          ],
        }),
      ).toBe("failing");
    }
  });

  it("keeps a failure while sibling checks are still running", () => {
    const row = {
      ...rawMergedPr(),
      state: "OPEN",
      statusCheckRollup: [
        {
          __typename: "CheckRun",
          conclusion: "FAILURE",
          status: "COMPLETED",
          name: "Lint",
        },
        {
          __typename: "CheckRun",
          conclusion: null,
          status: "IN_PROGRESS",
          name: "Desktop E2E",
        },
      ],
    };

    expect(deriveChipState(row)).toBe("failing");
    expect(hasChecksStillRunning(row.statusCheckRollup ?? [])).toBe(true);
    expect(parseGhPrPayload(row)).toMatchObject({
      checkState: "failing",
      checksStillRunning: true,
    });
  });

  it("returns pending when any check is still running", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            name: "Lint",
          },
          {
            __typename: "CheckRun",
            conclusion: null,
            status: "IN_PROGRESS",
            name: "Build",
          },
        ],
      }),
    ).toBe("pending");
  });

  it("derives status-context failures independently from pending siblings", () => {
    const row = {
      ...rawMergedPr(),
      state: "OPEN",
      statusCheckRollup: [
        { __typename: "StatusContext", state: "FAILURE" },
        { __typename: "StatusContext", state: "PENDING" },
      ],
    };

    expect(deriveChipState(row)).toBe("failing");
    expect(hasChecksStillRunning(row.statusCheckRollup ?? [])).toBe(true);
  });

  it("does not mistake a completed conclusion with a stale progress status for work in flight", () => {
    expect(hasChecksStillRunning([
      {
        __typename: "CheckRun",
        conclusion: "SUCCESS",
        status: "IN_PROGRESS",
      },
    ])).toBe(false);
  });

  it("returns unknown when an OPEN PR has no checks at all", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [],
      }),
    ).toBe("unknown");
  });

  it("returns unknown for an unrecognized check conclusion", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        statusCheckRollup: [
          {
            __typename: "CheckRun",
            conclusion: "BIZARRE_FUTURE_CONCLUSION",
            status: "COMPLETED",
            name: "Future",
          },
        ],
      }),
    ).toBe("unknown");
  });
});

describe("parseGhAuthStatus", () => {
  // Pinned against `gh auth status --hostname github.com` from gh 2.88.1.
  const loggedInOutput = `github.com
  ✓ Logged in to github.com account huntharo (keyring)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'repo', 'read:org', 'workflow'`;

  it("flags installed=true, loggedIn=true, hasRepoScope=true on a healthy login", () => {
    const result = parseGhAuthStatus({
      stdout: "",
      stderr: loggedInOutput,
      ok: true,
    });
    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(true);
    expect(result.account).toBe("huntharo");
    expect(result.scopes).toEqual(["repo", "read:org", "workflow"]);
    expect(result.hasRepoScope).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("flags missing repo scope when scopes are present but `repo` is not", () => {
    const result = parseGhAuthStatus({
      stdout: "",
      stderr: loggedInOutput.replace(
        "'repo', 'read:org', 'workflow'",
        "'read:org', 'workflow'",
      ),
      ok: true,
    });
    expect(result.loggedIn).toBe(true);
    expect(result.hasRepoScope).toBe(false);
    expect(result.reason).toMatch(/repo.*scope/);
  });

  it("accepts public_repo as a sufficient scope for read-only access", () => {
    const result = parseGhAuthStatus({
      stdout: "",
      stderr: loggedInOutput.replace("'repo'", "'public_repo'"),
      ok: true,
    });
    expect(result.hasRepoScope).toBe(true);
  });

  it("flags loggedIn=false when no auth status is present", () => {
    const result = parseGhAuthStatus({
      stdout: "",
      stderr: "You are not logged into any GitHub hosts.\n",
      ok: false,
    });
    expect(result.installed).toBe(true);
    expect(result.loggedIn).toBe(false);
    expect(result.account).toBeUndefined();
    expect(result.scopes).toEqual([]);
    expect(result.reason).toMatch(/gh auth login/);
  });

  it("supports the older 'Logged in to github.com as <name>' format", () => {
    const result = parseGhAuthStatus({
      stdout: "",
      stderr: "github.com\n  ✓ Logged in to github.com as legacy-name\n",
      ok: true,
    });
    expect(result.account).toBe("legacy-name");
    expect(result.loggedIn).toBe(true);
  });
});

describe("GithubPrFetcher", () => {
  const primedPr = {
    provider: "github.com",
    number: 42,
    org: "pwrdrvr",
    repo: "PwrAgent",
    state: "passing" as const,
    checkState: "passing" as const,
    lifecycleState: "open" as const,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/42",
  };
  const mergedPr = parseGhPrPayload(rawMergedPr());

  function buildFetcher(overrides: {
    branchError?: Error;
    branchResults?: (ref: {
      owner: string;
      repo: string;
      branch: string;
    }) => PrSummary[] | undefined;
    ghAvailable?: boolean;
    repos?: Array<{ host: string; owner: string; repo: string }>;
    retainedError?: Error;
    retainedPrs?: PrSummary[];
  } = {}) {
    const fetchPullRequestsForBranches = vi.fn(async (refs: Array<{
      owner: string;
      repo: string;
      branch: string;
    }>) => {
      if (overrides.branchError) throw overrides.branchError;
      return new Map(
        refs.flatMap((ref) => {
          const prs = overrides.branchResults?.(ref) ?? [];
          return [[
            `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.branch}`,
            prs,
          ] as const];
        }),
      );
    });
    const fetchPullRequests = vi.fn(async () => {
      if (overrides.retainedError) throw overrides.retainedError;
      return overrides.retainedPrs ?? [];
    });
    const resolveGitHubRepos = vi.fn(async () =>
      overrides.repos ?? [{
        host: "github.com",
        owner: "pwrdrvr",
        repo: "PwrAgent",
      }],
    );
    const probeGhAvailable = vi.fn(async () => overrides.ghAvailable ?? true);
    const fetcher = new GithubPrFetcher({
      graphqlClient: {
        fetchPullRequests,
        fetchPullRequestsForBranches,
      },
      probeGhAvailable,
      resolveGitHubRepos,
    });
    return {
      fetcher,
      fetchPullRequests,
      fetchPullRequestsForBranches,
      probeGhAvailable,
      resolveGitHubRepos,
    };
  }

  describe("primeBranchLookup (batched in-process discovery)", () => {
    it("answers from the primed value without another GraphQL request", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      fetcher.primeBranchLookup([
        { cwd: "/repo", branch: "feat/x", prs: [primedPr] },
      ]);

      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
      });

      expect(result).toEqual([primedPr]);
      expect(fetchPullRequestsForBranches).not.toHaveBeenCalled();
    });

    it("honors a primed empty answer — that is an authoritative 'no PRs'", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      fetcher.primeBranchLookup([{ cwd: "/repo", branch: "feat/x", prs: [] }]);

      await expect(
        fetcher.fetchAllPullRequestsForBranch({ cwd: "/repo", branch: "feat/x" }),
      ).resolves.toEqual([]);
      expect(fetchPullRequestsForBranches).not.toHaveBeenCalled();
    });

    it("is single-use, so a later refresh gets its own fresh read", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      fetcher.primeBranchLookup([
        { cwd: "/repo", branch: "feat/x", prs: [primedPr] },
      ]);

      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
      });
      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
      });

      expect(fetchPullRequestsForBranches).toHaveBeenCalledTimes(1);
    });

    it("discards a primed discovery result for an authoritative user refresh", async () => {
      const freshPr = {
        ...primedPr,
        mergeState: "conflicting" as const,
      };
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        branchResults: () => [freshPr],
      });
      fetcher.primeBranchLookup([
        { cwd: "/repo", branch: "feat/x", prs: [primedPr] },
      ]);

      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
        allowPrimed: false,
      });

      expect(result).toEqual([
        expect.objectContaining({
          number: freshPr.number,
          mergeState: "conflicting",
        }),
      ]);
      expect(fetchPullRequestsForBranches).toHaveBeenCalledOnce();

      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
      });
      expect(fetchPullRequestsForBranches).toHaveBeenCalledTimes(2);
    });

    it("does not answer for a different branch or directory", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      fetcher.primeBranchLookup([
        { cwd: "/repo", branch: "feat/x", prs: [primedPr] },
      ]);

      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/other",
      });
      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/other-repo",
        branch: "feat/x",
      });

      expect(fetchPullRequestsForBranches).toHaveBeenCalledTimes(2);
    });

    it("runs GraphQL once the primed value has expired", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      fetcher.primeBranchLookup(
        [{ cwd: "/repo", branch: "feat/x", prs: [primedPr] }],
        -1,
      );

      await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/repo",
        branch: "feat/x",
      });

      expect(fetchPullRequestsForBranches).toHaveBeenCalledTimes(1);
    });
  });

  describe("fetchOpenPullRequests (batched by repo)", () => {
    it("returns [] without GraphQL when gh auth is not available", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        ghAvailable: false,
      });
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/x"],
      });
      expect(result).toEqual([]);
      expect(fetchPullRequestsForBranches).not.toHaveBeenCalled();
    });

    it("returns [] without GraphQL when no branches are requested", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher();
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: [],
      });
      expect(result).toEqual([]);
      expect(fetchPullRequestsForBranches).not.toHaveBeenCalled();
    });

    it("combines requested branches and filters terminal PRs", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        branchResults: (ref) => [
          {
            ...primedPr,
            number: ref.branch === "feat/a" ? 1 : 3,
            url: `${primedPr.url}-${ref.branch}`,
          },
          mergedPr,
        ],
      });
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/a", "feat/c"],
      });
      expect(result.map((pr) => pr.number)).toEqual([1, 3]);
      expect(fetchPullRequestsForBranches).toHaveBeenCalledWith([
        { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/a" },
        { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/c" },
      ]);
    });

    it("returns [] on in-process lookup failure", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        branchError: new Error("GraphQL unavailable"),
      });
      const first = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/x"],
      });
      const second = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/x"],
      });
      expect(first).toEqual([]);
      expect(second).toEqual([]);
      expect(fetchPullRequestsForBranches).toHaveBeenCalledTimes(2);
    });

    it("does not probe gh or GraphQL for a non-GitHub checkout", async () => {
      const {
        fetcher,
        fetchPullRequestsForBranches,
        probeGhAvailable,
      } = buildFetcher({ repos: [] });

      await expect(fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/x"],
      })).resolves.toEqual([]);
      expect(probeGhAvailable).not.toHaveBeenCalled();
      expect(fetchPullRequestsForBranches).not.toHaveBeenCalled();
    });
  });

  describe("fetchAllPullRequestsForBranch (single thread, all states)", () => {
    it("uses the in-process all-state branch query", async () => {
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        branchResults: () => [mergedPr],
      });
      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/tmp/repo",
        branch: "feat/x",
      });
      expect(result).toEqual([mergedPr]);
      expect(fetchPullRequestsForBranches).toHaveBeenCalledWith([
        { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/x" },
      ]);
    });

    it("returns [] on in-process lookup failure", async () => {
      const { fetcher } = buildFetcher({
        branchError: new Error("GraphQL unavailable"),
      });
      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/tmp/repo",
        branch: "feat/x",
      });
      expect(result).toEqual([]);
    });

    it("queries fork and upstream remotes and deduplicates their answers", async () => {
      const upstreamPr = { ...primedPr, number: 43, url: `${primedPr.url}-43` };
      const { fetcher, fetchPullRequestsForBranches } = buildFetcher({
        repos: [
          { host: "github.com", owner: "operator", repo: "PwrAgent" },
          { host: "github.com", owner: "pwrdrvr", repo: "PwrAgent" },
        ],
        branchResults: (ref) =>
          ref.owner === "operator"
            ? [primedPr]
            : [primedPr, upstreamPr],
      });

      await expect(fetcher.fetchAllPullRequestsForBranch({
        cwd: "/tmp/repo",
        branch: "feat/x",
      })).resolves.toEqual([primedPr, upstreamPr]);
      expect(fetchPullRequestsForBranches).toHaveBeenCalledWith([
        { owner: "operator", repo: "PwrAgent", branch: "feat/x" },
        { owner: "pwrdrvr", repo: "PwrAgent", branch: "feat/x" },
      ]);
    });
  });

  describe("fetchPullRequestByUrl", () => {
    it("uses the in-process by-number query for retained PR chips", async () => {
      const { fetcher, fetchPullRequests } = buildFetcher({
        retainedPrs: [mergedPr],
      });
      const result = await fetcher.fetchPullRequestByUrl({
        cwd: "/tmp/repo",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
      });
      expect(result).toEqual(mergedPr);
      expect(fetchPullRequests).toHaveBeenCalledWith([
        { owner: "pwrdrvr", repo: "PwrAgent", number: 178 },
      ]);
    });

    it("returns undefined on in-process lookup failure", async () => {
      const { fetcher } = buildFetcher({
        retainedError: new Error("GraphQL unavailable"),
      });
      const result = await fetcher.fetchPullRequestByUrl({
        cwd: "/tmp/repo",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
      });
      expect(result).toBeUndefined();
    });

    it("rejects a URL that does not identify a GitHub pull request", async () => {
      const { fetcher, fetchPullRequests } = buildFetcher();

      await expect(fetcher.fetchPullRequestByUrl({
        cwd: "/tmp/repo",
        url: "https://github.com/pwrdrvr/PwrAgent/issues/178",
      })).resolves.toBeUndefined();
      expect(fetchPullRequests).not.toHaveBeenCalled();
    });
  });

  describe("isGhAvailable / invalidateGhAvailable", () => {
    it("caches the probe and re-uses for repeated calls within the TTL", async () => {
      const { fetcher, probeGhAvailable } = buildFetcher();
      await fetcher.isGhAvailable();
      await fetcher.isGhAvailable();
      await fetcher.isGhAvailable();
      expect(probeGhAvailable).toHaveBeenCalledTimes(1);
    });

    it("re-probes after invalidateGhAvailable() — backs the Re-check button", async () => {
      const { fetcher, probeGhAvailable } = buildFetcher();
      await fetcher.isGhAvailable();
      fetcher.invalidateGhAvailable();
      await fetcher.isGhAvailable();
      expect(probeGhAvailable).toHaveBeenCalledTimes(2);
    });
  });

  describe("getAuthStatus / invalidateGhCaches", () => {
    function buildAuthFetcher() {
      const probeGhAvailable = vi.fn(async () => true);
      const runGhAuthStatus = vi.fn(async () => ({
        stdout:
          "github.com\n  ✓ Logged in to github.com account huntharo\n  - Token scopes: 'gist', 'repo', 'workflow'\n",
        stderr: "",
        ok: true,
      }));
      const fetcher = new GithubPrFetcher({
        probeGhAvailable,
        runGhAuthStatus,
      });
      return { fetcher, probeGhAvailable, runGhAuthStatus };
    }

    it("caches the auth status across repeat calls — second call hits the cache", async () => {
      // The Applications settings panel mounts twice in dev under
      // React StrictMode. The first call probes; the second must
      // return the cached value WITHOUT spawning `gh auth status`
      // again.
      const { fetcher, runGhAuthStatus } = buildAuthFetcher();
      const first = await fetcher.getAuthStatus();
      const second = await fetcher.getAuthStatus();
      expect(runGhAuthStatus).toHaveBeenCalledTimes(1);
      // Cached value carries the same parsed shape.
      expect(second.installed).toBe(first.installed);
      expect(second.loggedIn).toBe(first.loggedIn);
      expect(second.scopes).toEqual(first.scopes);
    });

    it("evicts the cache after authStatusCacheTtlMs and re-probes on next call", async () => {
      // TTL is constructor-injectable so this test runs without
      // timer mocks. ttl=0 means every call is a cache miss.
      const probeGhAvailable = vi.fn(async () => true);
      const runGhAuthStatus = vi.fn(async () => ({
        stdout:
          "github.com\n  ✓ Logged in to github.com account huntharo\n  - Token scopes: 'repo'\n",
        stderr: "",
        ok: true,
      }));
      const fetcher = new GithubPrFetcher({
        probeGhAvailable,
        runGhAuthStatus,
        authStatusCacheTtlMs: 0,
      });
      await fetcher.getAuthStatus();
      await fetcher.getAuthStatus();
      expect(runGhAuthStatus).toHaveBeenCalledTimes(2);
    });

    it("dedupes concurrent calls — two parallel callers share one subprocess", async () => {
      // The bug this is locking in: the StrictMode dev double-mount
      // fires both IPC calls in parallel. Both miss the resolved-
      // value cache (which is only populated after the subprocess
      // returns). Without in-flight dedup, both spawn `gh auth
      // status` and both log. With it, the second caller awaits the
      // first's promise.
      const probeGhAvailable = vi.fn(async () => true);
      let resolveProbe: (() => void) | undefined;
      const runGhAuthStatus = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          resolveProbe = resolve;
        });
        return {
          stdout:
            "github.com\n  ✓ Logged in to github.com account huntharo\n  - Token scopes: 'repo'\n",
          stderr: "",
          ok: true,
        };
      });
      const fetcher = new GithubPrFetcher({
        probeGhAvailable,
        runGhAuthStatus,
      });

      // Fire two calls before either resolves.
      const firstPromise = fetcher.getAuthStatus();
      const secondPromise = fetcher.getAuthStatus();

      // Let the (single) subprocess finish.
      await new Promise<void>((resolve) => setImmediate(resolve));
      resolveProbe?.();

      const [first, second] = await Promise.all([firstPromise, secondPromise]);

      // Only one subprocess invocation across both callers.
      expect(runGhAuthStatus).toHaveBeenCalledTimes(1);
      // Both callers see the same parsed value.
      expect(first.loggedIn).toBe(true);
      expect(second.loggedIn).toBe(true);
    });

    it("re-runs after invalidateGhCaches() — drives the Re-check button", async () => {
      const { fetcher, probeGhAvailable, runGhAuthStatus } = buildAuthFetcher();
      await fetcher.getAuthStatus();
      fetcher.invalidateGhCaches();
      await fetcher.getAuthStatus();
      expect(runGhAuthStatus).toHaveBeenCalledTimes(2);
      // invalidateGhCaches must clear the gh-availability cache too,
      // otherwise the `gh --version` probe stays stale across a
      // Re-check.
      expect(probeGhAvailable).toHaveBeenCalledTimes(2);
    });

    it("caches the negative result when gh is not installed", async () => {
      const probeGhAvailable = vi.fn(async () => false);
      const runGhAuthStatus = vi.fn(async () => ({
        stdout: "",
        stderr: "",
        ok: false,
      }));
      const fetcher = new GithubPrFetcher({
        probeGhAvailable,
        runGhAuthStatus,
      });
      const first = await fetcher.getAuthStatus();
      const second = await fetcher.getAuthStatus();
      expect(first.installed).toBe(false);
      expect(second.installed).toBe(false);
      // Never spawned `gh auth status` when gh wasn't installed —
      // and the negative result is cached too (probe only fires once).
      expect(runGhAuthStatus).not.toHaveBeenCalled();
      expect(probeGhAvailable).toHaveBeenCalledTimes(1);
    });
  });
});
