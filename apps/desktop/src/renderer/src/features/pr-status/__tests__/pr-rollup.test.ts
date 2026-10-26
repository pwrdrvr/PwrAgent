import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { prRollupLabel, resolvePrRollup } from "../pr-rollup";

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    ...overrides,
  };
}

const conflict = pr(1, { mergeState: "conflicting" });
const failed = pr(2, { checkState: "failing", state: "failing" });
const failingRunning = pr(3, {
  checkState: "failing",
  state: "failing",
  checksStillRunning: true,
});
const running = pr(4, { checkState: "pending", state: "pending" });
const ready = pr(5);
const draft = pr(6, { reviewState: "draft" });
const unknown: PrSummary = {
  ...pr(7),
  state: "unknown",
  checkState: undefined,
  lifecycleState: undefined,
  reviewState: undefined,
  mergeState: undefined,
};
const merged = pr(8, { lifecycleState: "merged", state: "merged" });
const closed = pr(9, { lifecycleState: "closed", state: "closed", checkState: "failing" });

const numbers = (prs: PrSummary[]) => prs.map((entry) => entry.number);

describe("resolvePrRollup", () => {
  it("is undefined without pull requests", () => {
    expect(resolvePrRollup([])).toBeUndefined();
  });

  it("shows the least ready open PR, in the operator's order", () => {
    const rollup = resolvePrRollup([
      ready, running, failingRunning, failed, conflict,
    ])!;
    expect(rollup.representative).toBe(conflict);
    expect(numbers(rollup.ordered)).toEqual([1, 2, 3, 4, 5]);
    expect(rollup.summary).toBe("ready for review · merge conflict · checks passing");
  });

  it("ranks a settled failure above one whose checks are still running", () => {
    expect(resolvePrRollup([failingRunning, failed])!.representative).toBe(failed);
    expect(resolvePrRollup([running, failingRunning])!.summary).toBe(
      "ready for review · checks failing · checks still running",
    );
  });

  it("ranks running checks above passing ones", () => {
    const rollup = resolvePrRollup([ready, running])!;
    expect(rollup.representative).toBe(running);
    expect(rollup.summary).toBe("ready for review · checks pending");
  });

  it("shows a draft before a ready PR when both pass", () => {
    const rollup = resolvePrRollup([ready, draft])!;
    expect(rollup.representative).toBe(draft);
    expect(rollup.summary).toBe("draft · checks passing");
    expect(resolvePrRollup([ready])!.summary).toBe("ready for review · checks passing");
  });

  it("lets a known status outrank an unpolled attachment", () => {
    expect(resolvePrRollup([unknown, ready])!.representative).toBe(ready);
    expect(resolvePrRollup([unknown])!.summary).toBe("status unknown");
  });

  it("summarizes the representative in the popover rows' words", () => {
    // Polled, but no checks reported: still a known, open PR.
    const noChecks = pr(11, { checkState: "unknown", state: "unknown" });
    expect(resolvePrRollup([noChecks, merged])!.summary).toBe(
      "ready for review · status unknown",
    );
  });

  it("ignores closed and merged PRs while any PR is open", () => {
    const rollup = resolvePrRollup([closed, merged, ready])!;
    expect(rollup.representative).toBe(ready);
    expect(rollup.openCount).toBe(1);
    // Finished PRs still list, after the open ones, merged first.
    expect(numbers(rollup.ordered)).toEqual([5, 8, 9]);
  });

  it("reports merged once every PR has finished and any merged", () => {
    const rollup = resolvePrRollup([closed, merged])!;
    expect(rollup.representative).toBe(merged);
    expect(rollup.summary).toBe("all merged or closed");
    expect(resolvePrRollup([merged])!.summary).toBe("merged");
    expect(resolvePrRollup([merged, pr(12, { lifecycleState: "merged" })])!.summary)
      .toBe("all merged");
  });

  it("reports closed when every PR closed without merging", () => {
    expect(resolvePrRollup([closed])!.summary).toBe("closed without merge");
    expect(resolvePrRollup([closed, pr(10, { lifecycleState: "closed" })])!.summary)
      .toBe("all closed");
  });
});

describe("prRollupLabel", () => {
  it("names one PR by number and counts several", () => {
    expect(prRollupLabel([ready])).toBe("#5");
    expect(prRollupLabel([ready, running, merged])).toBe("3 PRs");
  });
});
