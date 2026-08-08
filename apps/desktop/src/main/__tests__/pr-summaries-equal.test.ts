import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { prSummariesEqual } from "../ipc/app-server";

/**
 * `prSummariesEqual` gates snapshot republication. A field the hover card
 * renders but this comparison ignores produces a silent staleness bug — the
 * value moves, the snapshot is judged unchanged, and no open window is ever
 * told. These tests exist so deleting a comparison fails here instead of
 * quietly shipping stale chips.
 */
function basePr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 743,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Retain thread pull request history",
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

  it("distinguishes a field going absent from it holding a value", () => {
    // Absent and zero are different claims everywhere else in this feature;
    // they have to be different here too, or a provider that stops reporting
    // stats leaves the last-known numbers frozen on screen.
    expect(
      prSummariesEqual([basePr()], [basePr({ additions: undefined })]),
    ).toBe(false);
  });

  it("still detects the status changes it always did", () => {
    expect(
      prSummariesEqual([basePr()], [basePr({ checkState: "failing" })]),
    ).toBe(false);
    expect(
      prSummariesEqual([basePr()], [basePr({ lifecycleState: "merged" })]),
    ).toBe(false);
    expect(prSummariesEqual([basePr()], [])).toBe(false);
  });
});
