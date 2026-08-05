import { describe, expect, it } from "vitest";
import { PrPollingFocusTracker } from "../pr-status/pr-polling-focus";

describe("PrPollingFocusTracker", () => {
  it("unions focus across senders instead of letting the last write win", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.set(202, ["codex:thread-2"]);

    // The regression this guards against: a second window's push replacing
    // the first window's fast tier (single shared Set behavior).
    expect([...tracker.union()].sort()).toEqual([
      "codex:thread-1",
      "codex:thread-2",
    ]);
  });

  it("replaces only the pushing sender's previous focus", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.set(202, ["codex:thread-2"]);
    tracker.set(101, ["codex:thread-3"]);

    expect([...tracker.union()].sort()).toEqual([
      "codex:thread-2",
      "codex:thread-3",
    ]);
  });

  it("drops a sender on an empty push", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.set(202, ["codex:thread-2"]);
    tracker.set(101, []);

    expect([...tracker.union()]).toEqual(["codex:thread-2"]);
  });

  it("drops a sender when its window closes", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.set(202, ["codex:thread-2"]);
    tracker.clearSender(202);

    expect([...tracker.union()]).toEqual(["codex:thread-1"]);
  });

  it("dedupes the same thread focused in two windows", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.set(202, ["codex:thread-1"]);

    expect([...tracker.union()]).toEqual(["codex:thread-1"]);
    tracker.clearSender(101);
    expect([...tracker.union()]).toEqual(["codex:thread-1"]);
  });

  it("clears everything on reset", () => {
    const tracker = new PrPollingFocusTracker();
    tracker.set(101, ["codex:thread-1"]);
    tracker.clear();

    expect(tracker.union().size).toBe(0);
  });
});
