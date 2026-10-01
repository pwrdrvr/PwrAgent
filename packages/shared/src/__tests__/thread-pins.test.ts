import { describe, expect, it } from "vitest";
import {
  buildAppendPinRank,
  buildPinnedRanks,
  buildPrependPinRank,
  buildTierPinRanks,
  comparePinnedThreads,
  comparePinRanks,
  compareThreadsByCreatedAtDesc,
  isKeptAtTopRank,
  KEEP_AT_TOP_RANK_BOUNDARY,
  moveThreadKey,
} from "../thread-pins";

describe("thread pins", () => {
  it("appends after the highest existing rank", () => {
    expect(buildAppendPinRank([])).toBe("1024");
    expect(buildAppendPinRank(["1024", "3072", undefined, "bad"])).toBe("4096");
  });

  it("prepends before the lowest existing rank, past zero when needed", () => {
    expect(buildPrependPinRank([])).toBe("1024");
    expect(buildPrependPinRank(["3072", "1024", undefined, "bad"])).toBe("0");
    expect(buildPrependPinRank(["0", "2048"])).toBe("-1024");
    const ranks = ["-1024", "0", "1024"];
    const prepended = buildPrependPinRank(ranks);
    expect([...ranks, prepended].sort(comparePinRanks)[0]).toBe(prepended);
  });

  it("keeps the kept-at-top band ahead of new ordinary pins", () => {
    const kept = buildTierPinRanks(["release"], true).release!;
    expect(isKeptAtTopRank(kept)).toBe(true);
    expect(isKeptAtTopRank(String(KEEP_AT_TOP_RANK_BOUNDARY))).toBe(false);
    expect(isKeptAtTopRank("-1024")).toBe(false);
    expect(isKeptAtTopRank(undefined)).toBe(false);
    // A new thread pins at the top of the ordinary pins, never above a kept one.
    const prepended = buildPrependPinRank([kept, "1024", "2048"]);
    expect(prepended).toBe("0");
    expect([prepended, "1024", kept].sort(comparePinRanks)).toEqual([kept, prepended, "1024"]);
    expect(buildPrependPinRank([kept])).toBe("1024");
    // Appending ignores the band too, so an ordinary pin never lands in it.
    expect(buildAppendPinRank([kept])).toBe("1024");
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

  it("sorts created threads deterministically when creation timestamps are missing", () => {
    const sorted = [
      { id: "legacy-z", updatedAt: 9_000 },
      { id: "created-newer", createdAt: 2_000, updatedAt: 2_000 },
      { id: "legacy-a", updatedAt: 10_000 },
      { id: "created-older", createdAt: 1_000, updatedAt: 8_000 },
    ].sort(compareThreadsByCreatedAtDesc);

    expect(sorted.map((thread) => thread.id)).toEqual([
      "created-newer",
      "created-older",
      "legacy-z",
      "legacy-a",
    ]);
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
