import { describe, expect, it } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import {
  computePrStatusTransition,
  summarizePrStatusTransition,
} from "../pr-status/pr-transitions";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number: 12,
    org: "pwrdrvr",
    repo: "PwrAgent",
    title: "Add polling",
    state: "pending",
    checkState: "pending",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    commitShas: ["a".repeat(40)],
    url: "https://github.com/pwrdrvr/PwrAgent/pull/12",
    ...overrides,
  };
}

describe("computePrStatusTransition", () => {
  it("returns undefined on first sight (no previous), so boot emits nothing", () => {
    expect(computePrStatusTransition(undefined, pr())).toBeUndefined();
  });

  it("returns undefined when nothing meaningful changed", () => {
    // Only the commit SHA moved — a new commit with identical status is not a
    // status transition.
    expect(
      computePrStatusTransition(pr(), pr({ commitShas: ["b".repeat(40)] })),
    ).toBeUndefined();
  });

  it("captures a CI failure (the flagship case)", () => {
    const transition = computePrStatusTransition(
      pr({ checkState: "pending", state: "pending" }),
      pr({ checkState: "failing", state: "failing" }),
    );
    expect(transition?.changed).toEqual({
      checkState: { from: "pending", to: "failing" },
    });
    expect(transition?.prKey).toBe("github.com/pwrdrvr/pwragent#12");
    expect(transition?.url).toBe("https://github.com/pwrdrvr/PwrAgent/pull/12");
  });

  it("captures a merge", () => {
    const transition = computePrStatusTransition(
      pr({ lifecycleState: "open" }),
      pr({ lifecycleState: "merged", mergeState: "unknown" }),
    );
    expect(transition?.changed.lifecycleState).toEqual({ from: "open", to: "merged" });
    expect(transition?.changed.mergeState).toEqual({ from: "mergeable", to: "unknown" });
  });

  it("captures a newly developed merge conflict", () => {
    const transition = computePrStatusTransition(
      pr({ mergeState: "mergeable" }),
      pr({ mergeState: "conflicting" }),
    );
    expect(transition?.changed).toEqual({
      mergeState: { from: "mergeable", to: "conflicting" },
    });
  });

  it("captures draft → ready", () => {
    const transition = computePrStatusTransition(
      pr({ reviewState: "draft" }),
      pr({ reviewState: "ready_for_review" }),
    );
    expect(transition?.changed.reviewState).toEqual({
      from: "draft",
      to: "ready_for_review",
    });
  });

  it("captures a title edit", () => {
    const transition = computePrStatusTransition(
      pr({ title: "old" }),
      pr({ title: "new" }),
    );
    expect(transition?.changed.title).toEqual({ from: "old", to: "new" });
  });

  it("coalesces multiple simultaneous flips into ONE transition", () => {
    // A push that fails CI and title-renames in the same poll interval.
    const transition = computePrStatusTransition(
      pr({ checkState: "passing", state: "passing", title: "old" }),
      pr({ checkState: "failing", state: "failing", title: "new" }),
    );
    expect(Object.keys(transition?.changed ?? {}).sort()).toEqual([
      "checkState",
      "title",
    ]);
  });

  it("prefers checkState and ignores a legacy `state` alias value", () => {
    // Old cached row carried a legacy chip value in `state`; the canonical
    // `checkState` did not change, so this is not a check transition.
    const previous = pr({ checkState: "passing", state: "merged" });
    const next = pr({ checkState: "passing", state: "passing" });
    expect(computePrStatusTransition(previous, next)).toBeUndefined();
  });

  it("carries commit SHAs and threadKeys through for the future ingestor", () => {
    const transition = computePrStatusTransition(
      pr({ checkState: "pending" }),
      pr({ checkState: "passing", commitShas: ["c".repeat(40)] }),
      ["codex:t1", "codex:t2"],
    );
    expect(transition?.commitShas).toEqual(["c".repeat(40)]);
    expect(transition?.threadKeys).toEqual(["codex:t1", "codex:t2"]);
  });

  it("defaults threadKeys to empty when none are supplied", () => {
    const transition = computePrStatusTransition(
      pr({ checkState: "pending" }),
      pr({ checkState: "passing" }),
    );
    expect(transition?.threadKeys).toEqual([]);
  });
});

describe("summarizePrStatusTransition", () => {
  it("renders each flip as from→to for logs", () => {
    const transition = computePrStatusTransition(
      pr({ checkState: "pending", state: "pending" }),
      pr({ checkState: "failing", state: "failing" }),
    )!;
    expect(summarizePrStatusTransition(transition)).toEqual({
      prKey: "github.com/pwrdrvr/pwragent#12",
      threadCount: 0,
      changes: { checkState: "pending→failing" },
    });
  });
});
