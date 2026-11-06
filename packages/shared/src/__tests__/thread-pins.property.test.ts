import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  buildAppendPinRank,
  buildPrependPinRank,
  buildTierPinRanks,
  comparePinRanks,
  comparePinnedThreads,
  isKeptAtTopRank,
  KEEP_AT_TOP_RANK_BOUNDARY,
} from "../thread-pins";

const keys = (count: number, tier: string): string[] =>
  Array.from({ length: count }, (_, index) => `${tier}-${index}`);

describe("pin-rank properties (AGENTS.md: Inbox, Recents, and Directories)", () => {
  it("compacts each tier without ties and agrees with the tier boundary and both comparators", () => {
    fc.assert(fc.property(fc.nat(40), fc.nat(40), (keptCount, ordinaryCount) => {
      const kept = keys(keptCount, "kept");
      const ordinary = keys(ordinaryCount, "ordinary");
      const expected = [...kept, ...ordinary];
      const ranks = { ...buildTierPinRanks(kept, true), ...buildTierPinRanks(ordinary, false) };
      expect(new Set(Object.values(ranks).map(Number)).size).toBe(expected.length);
      for (const key of expected) {
        expect(isKeptAtTopRank(ranks[key])).toBe(kept.includes(key));
        expect(Number(ranks[key]) < KEEP_AT_TOP_RANK_BOUNDARY).toBe(kept.includes(key));
      }
      // Reverse input and timestamps so neither insertion order nor activity
      // can accidentally stand in for the operator's rank order.
      const rows = expected.map((id, updatedAt) => ({ id, pinnedRank: ranks[id], updatedAt })).reverse();
      expect([...rows].sort(comparePinnedThreads).map((row) => row.id)).toEqual(expected);
      expect([...rows].sort((a, b) => comparePinRanks(a.pinnedRank, b.pinnedRank)).map((row) => row.id))
        .toEqual(expected);
    }));
  });

  it("every prepend is a fresh ordinary head and every append a fresh ordinary tail", () => {
    fc.assert(fc.property(fc.nat(20), fc.array(fc.boolean(), { maxLength: 60 }), (keptCount, prepends) => {
      const kept = keys(keptCount, "kept");
      const ranks = buildTierPinRanks(kept, true);
      const ordinary: string[] = [];
      for (const [index, prepend] of prepends.entries()) {
        const id = `new-${index}`;
        ranks[id] = prepend
          ? buildPrependPinRank(Object.values(ranks))
          : buildAppendPinRank(Object.values(ranks));
        if (prepend) ordinary.unshift(id);
        else ordinary.push(id);
        expect(isKeptAtTopRank(ranks[id])).toBe(false);
        expect(new Set(Object.values(ranks).map(Number)).size).toBe(Object.keys(ranks).length);
        expect(Object.keys(ranks).sort((a, b) => comparePinRanks(ranks[a], ranks[b])))
          .toEqual([...kept, ...ordinary]);
      }
    }));
  });

  it("compares finite ranks numerically with antisymmetry and transitivity", () => {
    fc.assert(fc.property(fc.tuple(fc.integer(), fc.integer(), fc.integer()), (values) => {
      const rows = values.map((value, index) => ({ id: `thread-${index}`, pinnedRank: String(value) }));
      const expected = [...rows].sort((a, b) => Number(a.pinnedRank) - Number(b.pinnedRank)
        || a.id.localeCompare(b.id));
      expect([...rows].sort(comparePinnedThreads)).toEqual(expected);
      for (const a of rows) for (const b of rows) {
        expect(Math.sign(comparePinRanks(a.pinnedRank, b.pinnedRank))
          + Math.sign(comparePinRanks(b.pinnedRank, a.pinnedRank))).toBe(0);
        for (const c of rows) {
          if (comparePinRanks(a.pinnedRank, b.pinnedRank) <= 0 && comparePinRanks(b.pinnedRank, c.pinnedRank) <= 0) {
            expect(comparePinRanks(a.pinnedRank, c.pinnedRank)).toBeLessThanOrEqual(0);
          }
        }
      }
    }));
  });
});
