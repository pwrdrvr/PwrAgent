import { describe, expect, it } from "vitest";
import type { NavigationDirectorySummary } from "../contracts/navigation";
import {
  comparePinnedDirectories,
  isPinnedDirectory,
  moveDirectoryKey,
} from "../directory-pins";

function makeDirectory(
  overrides: Partial<NavigationDirectorySummary> & { key: string },
): NavigationDirectorySummary {
  return {
    kind: "directory",
    label: overrides.key,
    threadKeys: [],
    needsAttentionCount: 0,
    ...overrides,
  };
}

describe("directory pins", () => {
  it("treats a directory with a pinnedRank as pinned", () => {
    expect(isPinnedDirectory({ pinnedRank: "1024" })).toBe(true);
    expect(isPinnedDirectory({ pinnedRank: undefined })).toBe(false);
    expect(isPinnedDirectory({})).toBe(false);
  });

  it("sorts pinned directories by rank with latestUpdatedAt + key tie breakers", () => {
    const sorted = [
      makeDirectory({ key: "b", pinnedRank: "2048", latestUpdatedAt: 3 }),
      makeDirectory({ key: "c", pinnedRank: "1024", latestUpdatedAt: 1 }),
      makeDirectory({ key: "a", pinnedRank: "2048", latestUpdatedAt: 5 }),
    ].sort(comparePinnedDirectories);

    // c first (lowest rank), then within rank "2048" the one with the
    // higher latestUpdatedAt (a, 5) wins over (b, 3), mirroring the
    // thread-pin comparator's tie-breaker semantics.
    expect(sorted.map((directory) => directory.key)).toEqual(["c", "a", "b"]);
  });

  it("falls back to key when both rank and latestUpdatedAt match", () => {
    const sorted = [
      makeDirectory({ key: "delta", pinnedRank: "2048", latestUpdatedAt: 100 }),
      makeDirectory({ key: "alpha", pinnedRank: "2048", latestUpdatedAt: 100 }),
      makeDirectory({ key: "charlie", pinnedRank: "2048", latestUpdatedAt: 100 }),
    ].sort(comparePinnedDirectories);

    expect(sorted.map((directory) => directory.key)).toEqual([
      "alpha",
      "charlie",
      "delta",
    ]);
  });

  it("moves a dragged directory key before or after the target key", () => {
    expect(moveDirectoryKey(["a", "b", "c"], "c", "a", "before")).toEqual([
      "c",
      "a",
      "b",
    ]);
    expect(moveDirectoryKey(["a", "b", "c"], "a", "c", "after")).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("is a no-op when dragging a key onto itself", () => {
    // Matches moveThreadKey's early-out for the dragged === target
    // case so DirectoriesList's drag handler doesn't have to special
    // case the "drop on self" path.
    expect(moveDirectoryKey(["a", "b", "c"], "b", "b", "before")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});
