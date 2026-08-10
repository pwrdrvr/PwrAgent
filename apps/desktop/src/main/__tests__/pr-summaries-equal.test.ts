import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { prSummariesEqual } from "../ipc/app-server";

function basePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 743,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Retain pull request history",
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    additions: 412,
    deletions: 198,
    changedFiles: 18,
    commitCount: 7,
    createdAt: 1_700_000_000_000,
    url: "https://github.com/pwrdrvr/PwrAgent/pull/743",
    ...overrides,
  };
}

describe("prSummariesEqual", () => {
  it("treats an unchanged list as equal", () => {
    expect(prSummariesEqual([basePr()], [basePr()])).toBe(true);
  });

  it.each([
    ["additions", { additions: 530 }],
    ["deletions", { deletions: 4 }],
    ["changedFiles", { changedFiles: 21 }],
    ["commitCount", { commitCount: 9 }],
    ["createdAt", { createdAt: 1_700_000_999_000 }],
    ["mergedAt", { mergedAt: 1_800_000_000_000 }],
    ["closedAt", { closedAt: 1_800_000_000_000 }],
  ])("detects a change to %s alone", (_field, overrides) => {
    expect(
      prSummariesEqual([basePr()], [basePr(overrides as Partial<PrSummary>)]),
    ).toBe(false);
  });

  it("distinguishes an absent field from zero", () => {
    expect(
      prSummariesEqual([basePr()], [basePr({ additions: undefined })]),
    ).toBe(false);
  });
});
