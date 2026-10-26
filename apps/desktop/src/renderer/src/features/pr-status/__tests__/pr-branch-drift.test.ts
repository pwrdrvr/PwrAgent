import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import {
  findBranchDriftPr,
  prBranchBehindLabel,
  readPrBranchDrift,
} from "../pr-branch-drift";

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    headRefName: `feat/change-${number}`,
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    ...overrides,
  };
}

const anyRepository = () => true;

describe("findBranchDriftPr", () => {
  it("finds the open PR whose head is the thread's branch", () => {
    const other = pr(1);
    const onBranch = pr(2, { headRefName: "feat/drift" });
    expect(findBranchDriftPr({
      prs: [other, onBranch],
      branch: " feat/drift ",
      isThreadRepository: anyRepository,
    })).toBe(onBranch);
  });

  it("skips finished PRs, other repositories, and a detached HEAD", () => {
    const merged = pr(3, { headRefName: "feat/drift", lifecycleState: "merged" });
    const upstream = pr(4, { headRefName: "feat/drift", org: "upstream" });
    expect(findBranchDriftPr({
      prs: [merged, upstream],
      branch: "feat/drift",
      isThreadRepository: (candidate) => candidate.org === "acme",
    })).toBeUndefined();
    expect(findBranchDriftPr({
      prs: [pr(5, { headRefName: "HEAD" })],
      branch: "HEAD",
      isThreadRepository: anyRepository,
    })).toBeUndefined();
    expect(findBranchDriftPr({
      prs: [pr(6, { headRefName: undefined })],
      branch: undefined,
      isThreadRepository: anyRepository,
    })).toBeUndefined();
  });
});

describe("readPrBranchDrift", () => {
  const url = "https://github.com/acme/orbit/pull/2";

  it("keeps whole, non-negative counts and drops the rest", () => {
    expect(readPrBranchDrift({ url, baseBranch: "main", behind: 4.7, ahead: -2 }))
      .toEqual({ baseBranch: "main", behind: 4, ahead: undefined });
    expect(readPrBranchDrift({ url, baseBranch: "main" })).toBeUndefined();
    expect(readPrBranchDrift({ url, baseBranch: "", behind: 1 })).toBeUndefined();
  });

  it("names only a branch that is behind in the rollup's short form", () => {
    expect(prBranchBehindLabel({ url, baseBranch: "main", behind: 1200, ahead: 1 }))
      .toBe("1,200 behind main");
    expect(prBranchBehindLabel({ url, baseBranch: "main", behind: 0, ahead: 3 }))
      .toBeUndefined();
  });
});
