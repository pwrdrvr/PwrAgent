import { describe, expect, it } from "vitest";
import {
  PrActivityJournal,
  describePrCheck,
  prCheckTone,
  prRepairDecisionTone,
} from "../pr-status/pr-activity";

describe("PR activity history", () => {
  it("bounds memory and retains the newest events in causal order", () => {
    const journal = new PrActivityJournal(3);
    for (let i = 0; i < 5; i++) journal.record({ category: "budget", source: "Auto-fix",
      message: `event ${i}`, threadKeys: ["codex:fixture"], prKeys: ["github.com/example/repo#1"],
      budget: "repair", delta: -1 });
    expect(journal.snapshot().droppedEvents).toBe(2);
    expect(journal.snapshot().events.map((event) => event.id)).toEqual([5, 4, 3]);
    journal.snapshot().events.pop();
    expect(journal.snapshot().events).toHaveLength(3);
  });

  it("describes a check in the operator's words and marks what Auto-fix repairs", () => {
    expect(describePrCheck({ mergeState: "conflicting", checkState: "failing" }, false))
      .toBe("Merge conflict, checks failing");
    expect(describePrCheck({ mergeState: "mergeable", checkState: "pending" }, true))
      .toBe("Partial check: No conflicts, checks running");
    expect(prCheckTone({ mergeState: "conflicting", checkState: "passing" })).toBe("error");
    expect(prCheckTone({ mergeState: "mergeable", checkState: "failing" })).toBe("error");
    expect(prCheckTone({ mergeState: "mergeable", checkState: "passing" })).toBe("ok");
    expect(prCheckTone({ mergeState: "unknown", checkState: "passing" })).toBeUndefined();
  });

  it("tones repair decisions by whether the operator needs to look", () => {
    expect(prRepairDecisionTone("scheduled")).toBe("active");
    expect(prRepairDecisionTone("busy")).toBe("warning");
    expect(prRepairDecisionTone("failed")).toBe("error");
    expect(prRepairDecisionTone("not-actionable")).toBeUndefined();
  });
});
