import { describe, expect, it } from "vitest";
import {
  buildAppendPinRank,
  buildPinnedRanks,
  comparePinnedThreads,
  moveThreadKey,
} from "../thread-pins";

describe("thread pins", () => {
  it("appends after the highest existing rank", () => {
    expect(buildAppendPinRank([])).toBe("1024");
    expect(buildAppendPinRank(["1024", "3072", undefined, "bad"])).toBe("4096");
  });

  it("builds stable spaced ranks for a complete pinned order", () => {
    expect(buildPinnedRanks(["thread-a", "thread-b", "thread-c"])).toEqual({
      "thread-a": "1024",
      "thread-b": "2048",
      "thread-c": "3072",
    });
  });

  it("sorts pinned threads by rank with updated/id tie breakers", () => {
    const sorted = [
      { id: "b", pinnedRank: "2048", updatedAt: 3 },
      { id: "c", pinnedRank: "1024", updatedAt: 1 },
      { id: "a", pinnedRank: "2048", updatedAt: 5 },
    ].sort(comparePinnedThreads);

    expect(sorted.map((thread) => thread.id)).toEqual(["c", "a", "b"]);
  });

  it("moves a dragged key before or after the target key", () => {
    expect(moveThreadKey(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(moveThreadKey(["a", "b", "c"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });
});
