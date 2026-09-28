import { describe, expect, it } from "vitest";
import { PrActivityJournal } from "../pr-status/pr-activity";

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
});
