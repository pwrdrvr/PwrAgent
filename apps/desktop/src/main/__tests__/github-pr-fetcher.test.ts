import { describe, expect, it, vi } from "vitest";
import {
  GithubPrFetcher,
  deriveChipState,
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

describe("GithubPrFetcher", () => {
  function buildFetcher(overrides: {
    stdout?: string;
    error?: Error;
    ghAvailable?: boolean;
    cacheTtlMs?: number;
  } = {}) {
    const exec = vi.fn(async () => {
      if (overrides.error) throw overrides.error;
      return { stdout: overrides.stdout ?? "[]", stderr: "" };
    });
    const probeGhAvailable = vi.fn(async () => overrides.ghAvailable ?? true);
    const fetcher = new GithubPrFetcher({
      exec,
      probeGhAvailable,
      cacheTtlMs: overrides.cacheTtlMs,
    });
    return { fetcher, exec, probeGhAvailable };
  }

  it("returns [] without invoking gh when gh is not available", async () => {
    const { fetcher, exec } = buildFetcher({ ghAvailable: false });
    const result = await fetcher.fetchForBranch({
      cwd: "/tmp/repo",
      branch: "feat/x",
    });
    expect(result).toEqual([]);
    expect(exec).not.toHaveBeenCalled();
  });

  it("parses gh output and caches the result", async () => {
    const { fetcher, exec } = buildFetcher({
      stdout: JSON.stringify([rawMergedPr()]),
    });
    const first = await fetcher.fetchForBranch({
      cwd: "/tmp/repo",
      branch: "feat/x",
    });
    const second = await fetcher.fetchForBranch({
      cwd: "/tmp/repo",
      branch: "feat/x",
    });
    expect(first).toEqual([
      {
        number: 178,
        org: "pwrdrvr",
        repo: "PwrAgent",
        state: "merged",
        url: "https://github.com/pwrdrvr/PwrAgent/pull/178",
      },
    ]);
    expect(second).toBe(first); // same array reference from cache
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("evicts the cache after the TTL expires", async () => {
    const { fetcher, exec } = buildFetcher({
      stdout: "[]",
      cacheTtlMs: 1, // millisecond — expires immediately
    });
    await fetcher.fetchForBranch({ cwd: "/tmp/repo", branch: "feat/x" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fetcher.fetchForBranch({ cwd: "/tmp/repo", branch: "feat/x" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("returns [] and caches a stale-empty entry on subprocess failure", async () => {
    const { fetcher, exec } = buildFetcher({
      error: new Error("gh: not authorized"),
    });
    const first = await fetcher.fetchForBranch({
      cwd: "/tmp/repo",
      branch: "feat/x",
    });
    const second = await fetcher.fetchForBranch({
      cwd: "/tmp/repo",
      branch: "feat/x",
    });
    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // Failure result is cached so we don't hammer gh on every render.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("scopes cache by (cwd, branch)", async () => {
    const { fetcher, exec } = buildFetcher({ stdout: "[]" });
    await fetcher.fetchForBranch({ cwd: "/tmp/repo-a", branch: "main" });
    await fetcher.fetchForBranch({ cwd: "/tmp/repo-a", branch: "feat" });
    await fetcher.fetchForBranch({ cwd: "/tmp/repo-b", branch: "main" });
    expect(exec).toHaveBeenCalledTimes(3);
  });
});
