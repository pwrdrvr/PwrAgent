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

  it("coalesces unchanged observations per PR and thread without hiding a change", () => {
    const journal = new PrActivityJournal(10);
    const observe = (message: string, prKey = "github.com/acme/widgets#1", source = "background poll") =>
      journal.record({ category: "check", source, message, threadKeys: ["codex:one"], prKeys: [prKey] });
    const decide = () => journal.record({ category: "repair", source: "Auto-fix",
      message: "No repair needed", threadKeys: ["codex:one"], prKeys: ["github.com/acme/widgets#1"] });

    observe("No conflicts, checks passing");
    decide();
    observe("No conflicts, checks passing", undefined, "thread lookup (scheduled)");
    decide();
    observe("No conflicts, checks passing", "github.com/acme/widgets#2");
    let events = journal.snapshot().events;
    expect(events.map((event) => [event.prKeys[0], event.message, event.repeats])).toEqual([
      ["github.com/acme/widgets#2", "No conflicts, checks passing", undefined],
      ["github.com/acme/widgets#1", "No repair needed", 2],
      ["github.com/acme/widgets#1", "No conflicts, checks passing", 2],
    ]);
    expect(events[2]).toMatchObject({ source: "thread lookup (scheduled)" });
    expect(events[2]!.firstOccurredAt).toBeLessThanOrEqual(events[2]!.occurredAt);
    expect(journal.snapshot().droppedEvents).toBe(0);

    // A different result in between starts a new row for the next repeat.
    observe("Merge conflict, checks passing");
    observe("No conflicts, checks passing");
    events = journal.snapshot().events;
    expect(events.slice(0, 2).map((event) => [event.message, event.repeats]))
      .toEqual([["No conflicts, checks passing", undefined], ["Merge conflict, checks passing", undefined]]);
    expect(events).toHaveLength(5);
  });

  it("never coalesces budget events and forgets evicted streams", () => {
    const journal = new PrActivityJournal(2);
    const spend = () => journal.record({ category: "budget", budget: "polling", delta: -1,
      availableTokens: 5, source: "background poll", message: "PR check allowed",
      threadKeys: [], prKeys: [] });
    spend();
    spend();
    expect(journal.snapshot().events).toHaveLength(2);

    const observe = (prKey: string) => journal.record({ category: "check",
      source: "background poll", message: "No conflicts, checks passing",
      threadKeys: ["codex:one"], prKeys: [prKey] });
    observe("github.com/acme/widgets#1");
    observe("github.com/acme/widgets#2");
    observe("github.com/acme/widgets#3");
    // #1 was evicted, so its next observation is a new row, not a repeat.
    observe("github.com/acme/widgets#1");
    expect(journal.snapshot().events.map((event) => [event.prKeys[0], event.repeats])).toEqual([
      ["github.com/acme/widgets#1", undefined],
      ["github.com/acme/widgets#3", undefined],
    ]);
    expect(journal.snapshot().droppedEvents).toBe(4);
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

it("resolves each retained identity once per snapshot without retaining stale titles", () => {
  const journal = new PrActivityJournal();
  for (let i = 0; i < 2; i++) journal.record({ category: "budget", source: "background poll",
    message: "PR check allowed", threadKeys: ["codex:one", "codex:missing"],
    prKeys: ["git.example/acme/repo#1"], budget: "polling", delta: -1 });
  let title = "Collapsed project thread";
  const reads: string[] = [];
  const metadata = {
    threadTitle: (key: string) => { reads.push(key); return key === "codex:one" ? title : undefined; },
    prUrl: () => "https://git.example/acme/repo/-/merge_requests/1",
  };
  expect(journal.snapshot(metadata)).toMatchObject({
    threadTitles: { "codex:one": title },
    prUrls: { "git.example/acme/repo#1": metadata.prUrl() },
  });
  expect(reads).toEqual(["codex:one", "codex:missing"]);
  title = "Renamed thread";
  expect(journal.snapshot(metadata).threadTitles).toEqual({ "codex:one": title });
});
