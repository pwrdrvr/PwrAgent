import { describe, expect, it } from "vitest";
import {
  isStarMapArrangementEntry,
  mergeStarMapArrangementEntries,
  starMapArrangementEntryKey,
  type StarMapArrangementEntry,
} from "../star-map";

const entry = (
  overrides: Partial<StarMapArrangementEntry>,
): StarMapArrangementEntry => ({
  instanceId: "pwr_a",
  threadKey: "codex:t1",
  dx: 10,
  dy: -4,
  updatedAt: 100,
  by: "pwr_a",
  ...overrides,
});

const sorted = (entries: StarMapArrangementEntry[]) =>
  [...entries].sort((left, right) =>
    starMapArrangementEntryKey(left).localeCompare(
      starMapArrangementEntryKey(right),
    ),
  );

describe("isStarMapArrangementEntry", () => {
  it("accepts offsets and tombstones, rejects half-tombstones", () => {
    expect(isStarMapArrangementEntry(entry({}))).toBe(true);
    expect(isStarMapArrangementEntry(entry({ dx: null, dy: null }))).toBe(true);
    expect(isStarMapArrangementEntry(entry({ dx: null, dy: 3 }))).toBe(false);
    expect(isStarMapArrangementEntry(entry({ dx: Number.NaN }))).toBe(false);
    expect(isStarMapArrangementEntry(entry({ by: "" }))).toBe(false);
  });
});

describe("mergeStarMapArrangementEntries", () => {
  it("keeps the newer write per card", () => {
    const merged = mergeStarMapArrangementEntries(
      [entry({})],
      [entry({ dx: 50, dy: 50, updatedAt: 200, by: "pwr_b" })],
    );
    expect(merged.changed).toBe(true);
    expect(merged.entries).toEqual([
      entry({ dx: 50, dy: 50, updatedAt: 200, by: "pwr_b" }),
    ]);
  });

  it("breaks timestamp ties deterministically on the writer id", () => {
    const a = entry({ dx: 1, dy: 1, by: "pwr_a" });
    const b = entry({ dx: 2, dy: 2, by: "pwr_b" });
    const ab = mergeStarMapArrangementEntries([a], [b]).entries;
    const ba = mergeStarMapArrangementEntries([b], [a]).entries;
    expect(ab).toEqual(ba);
    expect(ab[0].by).toBe("pwr_b");
  });

  it("is idempotent and convergent under merge order", () => {
    const left = [
      entry({}),
      entry({ threadKey: "codex:t2", updatedAt: 300 }),
    ];
    const right = [
      entry({ dx: 9, dy: 9, updatedAt: 250, by: "pwr_b" }),
      entry({ instanceId: "pwr_b", threadKey: "codex:t3", updatedAt: 10 }),
    ];
    const lr = mergeStarMapArrangementEntries(left, right).entries;
    const rl = mergeStarMapArrangementEntries(right, left).entries;
    expect(sorted(lr)).toEqual(sorted(rl));
    const replay = mergeStarMapArrangementEntries(lr, right);
    expect(replay.changed).toBe(false);
  });

  it("propagates tombstones like any other write", () => {
    const merged = mergeStarMapArrangementEntries(
      [entry({})],
      [entry({ dx: null, dy: null, updatedAt: 500 })],
    );
    expect(merged.entries[0].dx).toBeNull();
    expect(merged.accepted).toHaveLength(1);
  });

  it("ignores malformed incoming entries", () => {
    const merged = mergeStarMapArrangementEntries(
      [],
      [
        entry({}),
        { bogus: true } as unknown as StarMapArrangementEntry,
      ],
    );
    expect(merged.entries).toEqual([entry({})]);
  });
});
