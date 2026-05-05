import { describe, expect, it, vi } from "vitest";
import {
  GithubPrFetcher,
  deriveChipState,
  parseGhAuthStatus,
  parseGhPrPayload,
} from "../pr-status/github-pr-fetcher";

// JSON shape pinned from `gh pr list --json …` against pwrdrvr/PwrAgent
// running gh 2.88.1 on 2026-05-04. If gh changes the shape, update these
// fixtures FIRST so the failure is loud and obvious.
function rawMergedPr() {
  return {
    number: 178,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
    state: "MERGED",
    isDraft: false,
    mergedAt: "2026-05-05T00:06:31Z",
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
      number: 178,
      org: "pwrdrvr",
      repo: "PwrAgent",
      state: "merged",
      url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
    });
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
});

describe("deriveChipState", () => {
  it("returns merged for MERGED state regardless of checks", () => {
    expect(deriveChipState({ ...rawMergedPr(), state: "MERGED" })).toBe(
      "merged",
    );
  });

  it("returns closed for CLOSED state without merge", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "CLOSED",
        mergedAt: null,
      }),
    ).toBe("closed");
  });

  it("returns draft for OPEN + isDraft", () => {
    expect(
      deriveChipState({
        ...rawMergedPr(),
        state: "OPEN",
        isDraft: true,
      }),
    ).toBe("draft");
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
  function buildFetcher(overrides: {
    stdout?: string;
    error?: Error;
    ghAvailable?: boolean;
  } = {}) {
    const exec = vi.fn(async (_cwd: string, _args: string[]) => {
      if (overrides.error) throw overrides.error;
      return { stdout: overrides.stdout ?? "[]", stderr: "" };
    });
    const probeGhAvailable = vi.fn(async () => overrides.ghAvailable ?? true);
    const fetcher = new GithubPrFetcher({ exec, probeGhAvailable });
    return { fetcher, exec, probeGhAvailable };
  }

  describe("fetchOpenPullRequests (batched by repo)", () => {
    it("returns [] without invoking gh when gh is not available", async () => {
      const { fetcher, exec } = buildFetcher({ ghAvailable: false });
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/x"],
      });
      expect(result).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it("returns [] without invoking gh when no branches are requested", async () => {
      const { fetcher, exec } = buildFetcher();
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: [],
      });
      expect(result).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it("filters gh output by requested branches", async () => {
      const { fetcher, exec } = buildFetcher({
        stdout: JSON.stringify([
          { ...rawMergedPr(), state: "OPEN", headRefName: "feat/a", number: 1 },
          { ...rawMergedPr(), state: "OPEN", headRefName: "feat/b", number: 2 },
          { ...rawMergedPr(), state: "OPEN", headRefName: "feat/c", number: 3 },
        ]),
      });
      const result = await fetcher.fetchOpenPullRequests({
        cwd: "/tmp/repo",
        branches: ["feat/a", "feat/c"],
      });
      expect(result.map((pr) => pr.number)).toEqual([1, 3]);
      expect(exec).toHaveBeenCalledTimes(1);
      const args = exec.mock.calls[0]![1];
      expect(args).toContain("--state");
      expect(args).toContain("open");
    });

    it("returns [] on subprocess failure (no caching — overlay handles persistence)", async () => {
      const { fetcher, exec } = buildFetcher({
        error: new Error("gh: not authorized"),
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
      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  describe("fetchAllPullRequestsForBranch (single thread, all states)", () => {
    it("uses --state all so we catch merged + closed too", async () => {
      const { fetcher, exec } = buildFetcher({
        stdout: JSON.stringify([rawMergedPr()]),
      });
      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/tmp/repo",
        branch: "feat/x",
      });
      expect(result).toEqual([
        {
          number: 178,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "merged",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
        },
      ]);
      const args = exec.mock.calls[0]![1];
      expect(args).toEqual([
        "pr",
        "list",
        "--state",
        "all",
        "--head",
        "feat/x",
        "--json",
        expect.any(String),
        "--limit",
        "5",
      ]);
    });

    it("returns [] on subprocess failure", async () => {
      const { fetcher } = buildFetcher({ error: new Error("gh failed") });
      const result = await fetcher.fetchAllPullRequestsForBranch({
        cwd: "/tmp/repo",
        branch: "feat/x",
      });
      expect(result).toEqual([]);
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
});
