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

  it("shows the least ready open PR on the chip, apart from the list order", () => {
    const rollup = resolvePrRollup([
      ready, running, failingRunning, failed, conflict,
    ])!;
    expect(rollup.representative).toBe(conflict);
    // Unpolled, so newest attachment first: the reverse of the input.
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
    // Finished PRs still list, after the open ones. Without merge or close
    // times, the later attachment is on top.
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

describe("resolvePrRollup list order", () => {
  const at = (minutes: number) => 1_700_000_000_000 + minutes * 60_000;

  it("stacks open PRs newest first above finished PRs newest first", () => {
    const rollup = resolvePrRollup([
      pr(3376, { lifecycleState: "merged", createdAt: at(0), mergedAt: at(50) }),
      pr(3399, { lifecycleState: "merged", createdAt: at(10), mergedAt: at(40) }),
      pr(3404, { lifecycleState: "merged", createdAt: at(20), mergedAt: at(60) }),
      pr(3430, { checkState: "pending", state: "pending", createdAt: at(70) }),
      pr(3431, { createdAt: at(80) }),
    ])!;
    expect(numbers(rollup.ordered)).toEqual([3431, 3430, 3404, 3376, 3399]);
    // The chip still wears the PR that needs the operator.
    expect(rollup.representative.number).toBe(3430);
  });

  it("moves a PR that merges to the top of the finished stack", () => {
    const finished = [
      pr(3376, { lifecycleState: "merged", mergedAt: at(50) }),
      pr(3399, { lifecycleState: "merged", mergedAt: at(40) }),
    ];
    const open = pr(3430, { createdAt: at(70) });
    expect(numbers(resolvePrRollup([...finished, open])!.ordered)).toEqual([3430, 3376, 3399]);
    const merged = { ...open, lifecycleState: "merged" as const, state: "merged" as const, mergedAt: at(90) };
    expect(numbers(resolvePrRollup([...finished, merged])!.ordered)).toEqual([3430, 3376, 3399]);
    const later = pr(3440, { lifecycleState: "closed", closedAt: at(95) });
    expect(numbers(resolvePrRollup([...finished, merged, later])!.ordered))
      .toEqual([3440, 3430, 3376, 3399]);
  });

  it("puts an unpolled attachment on top of the open stack", () => {
    const polled = pr(20, { createdAt: at(5) });
    const fresh = pr(10);
    expect(numbers(resolvePrRollup([fresh, polled])!.ordered)).toEqual([10, 20]);
  });
});

describe("resolvePrRollup lead", () => {
  it("names the only open PR however many have finished", () => {
    expect(resolvePrRollup([merged, running])!.lead).toBe(running);
    expect(resolvePrRollup([merged, closed, draft, pr(13, { lifecycleState: "merged" })])!.lead)
      .toBe(draft);
  });

  it("has no lead with several open PRs or none", () => {
    expect(resolvePrRollup([ready, running, merged])!.lead).toBeUndefined();
    expect(resolvePrRollup([merged, closed])!.lead).toBeUndefined();
  });
});

describe("prRollupLabel", () => {
  it("names one PR by number and counts several", () => {
    expect(prRollupLabel([ready])).toBe("#5");
    expect(prRollupLabel([ready, running, merged])).toBe("3 PRs");
  });
});
