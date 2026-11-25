import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ReadUsageActivityResponse } from "@pwragent/shared/contracts/usage-activity";
import { readUsageActivityInPieces, usageReadPieces, type UsageWindow } from "../usage-activity-pieces";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Every owner, including older peers, rejects a window over 31 days.
const OWNER_MAX_SPAN = 31 * DAY;

type FakeRow = { id: string; startedAt: number; completedAt: number; updatedAt: number };

/**
 * An owner: rows overlapping the window, newest update first, at most `cap`
 * of them, with the window rejected past 31 days. Mirrors the SQLite read.
 */
function owner(rows: readonly FakeRow[], cap: number) {
  const requests: Array<UsageWindow & { includeAccountTokenUsage: boolean }> = [];
  const read = async (window: UsageWindow, includeAccountTokenUsage: boolean): Promise<ReadUsageActivityResponse> => {
    requests.push({ ...window, includeAccountTokenUsage });
    if (!(window.to > window.from) || window.to - window.from > OWNER_MAX_SPAN) {
      throw new Error("Select a usage window of at most 31 days.");
    }
    const overlapping = rows.filter((row) => row.startedAt < window.to && row.completedAt >= window.from)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      rows: overlapping.slice(0, cap).map((row) => ({ line: { usageLineId: row.id }, title: row.id, updatedAt: row.updatedAt })) as never,
      truncated: overlapping.length > cap,
      readAt: window.to, rateLimits: [],
      limitHistory: [{ observedAt: window.from, limits: [] }],
      ...includeAccountTokenUsage ? { accountTokenUsage: [] } : {},
    };
  };
  return { read, requests };
}

const windowArb = fc.record({
  // Deliberately not hour-aligned.
  from: fc.integer({ min: 1_790_000_000_000, max: 1_790_000_000_000 + 10 * DAY }),
  span: fc.integer({ min: 1, max: 90 * DAY }),
}).map(({ from, span }) => ({ from, to: from + span }));

describe("reading a long usage period in pieces", () => {
  it("covers the window exactly in pieces every owner accepts, cut on whole hours", () => {
    fc.assert(fc.property(windowArb, ({ from, to }) => {
      const pieces = usageReadPieces(from, to);
      expect(pieces.at(0)!.to).toBe(to);
      expect(pieces.at(-1)!.from).toBe(from);
      for (const [index, piece] of pieces.entries()) {
        expect(piece.to).toBeGreaterThan(piece.from);
        expect(piece.to - piece.from).toBeLessThanOrEqual(OWNER_MAX_SPAN);
        if (index > 0) {
          // Adjacent, newest first, and the shared edge is a whole hour.
          expect(pieces[index - 1].from).toBe(piece.to);
          expect(piece.to % HOUR).toBe(0);
        }
      }
    }));
  });

  it("returns every overlapping row unless it says it is truncated, asks for token history once, and stays in budget", async () => {
    await fc.assert(fc.asyncProperty(
      windowArb,
      fc.array(fc.record({ start: fc.double({ min: 0, max: 1, noNaN: true }), length: fc.integer({ min: 0, max: 3 * DAY }),
        updated: fc.integer({ min: 0, max: 1_000_000 }) }), { maxLength: 60 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 4, max: 40 }),
      async (window, specs, cap, maxPieces) => {
        const rows = specs.map((spec, index) => {
          const startedAt = Math.floor(window.from - DAY + spec.start * (window.to - window.from + 2 * DAY));
          return { id: `row-${index}`, startedAt, completedAt: startedAt + spec.length, updatedAt: spec.updated };
        });
        const { read, requests } = owner(rows, cap);
        const merged = await readUsageActivityInPieces(read, window, { includeAccountTokenUsage: true, maxPieces });

        expect(requests.length).toBeLessThanOrEqual(Math.max(maxPieces, usageReadPieces(window.from, window.to).length));
        expect(requests.filter((request) => request.includeAccountTokenUsage)).toHaveLength(1);
        expect(requests[0].includeAccountTokenUsage).toBe(true);
        expect(merged.accountTokenUsage).toEqual([]);
        for (const request of requests) {
          expect(request.from).toBeGreaterThanOrEqual(window.from);
          expect(request.to).toBeLessThanOrEqual(window.to);
        }
        if (!merged.truncated) {
          const read = new Set(merged.rows.map((row) => row.line.usageLineId));
          const expected = rows.filter((row) => row.startedAt < window.to && row.completedAt >= window.from);
          for (const row of expected) expect(read.has(row.id)).toBe(true);
        }
        // Window readings combine across pieces, oldest first, without duplicates.
        const observed = (merged.limitHistory ?? []).map((reading) => reading.observedAt);
        expect(observed).toEqual([...new Set(observed)].sort((a, b) => a - b));
      },
    ));
  });

  it("issues no further owner reads once the viewer has moved on", async () => {
    await fc.assert(fc.asyncProperty(windowArb, fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 4 }),
      async (window, stopAfter, cap) => {
        // Dense rows so pieces split and the read would otherwise keep going.
        const rows = Array.from({ length: 40 }, (_, index) => {
          const startedAt = window.from + Math.floor(index * (window.to - window.from) / 40);
          return { id: `row-${index}`, startedAt, completedAt: startedAt, updatedAt: index };
        });
        const { read, requests } = owner(rows, cap);
        const unlimited = owner(rows, cap);
        await readUsageActivityInPieces(unlimited.read, window);
        const merged = await readUsageActivityInPieces(read, window, { shouldContinue: () => requests.length < stopAfter });
        expect(requests.length).toBe(Math.min(stopAfter, unlimited.requests.length));
        if (unlimited.requests.length > stopAfter) expect(merged.truncated).toBe(true);
      },
    ));
  });

  it("recovers a period whose newest rows alone exceed one read's bound", async () => {
    const from = Date.UTC(2026, 7, 27, 13, 31);
    const to = from + 90 * DAY;
    // 300 short turns a day, far past a 5,000-row bound over 90 days.
    const rows = Array.from({ length: 90 * 300 }, (_, index) => {
      const startedAt = from + Math.floor(index * (90 * DAY) / (90 * 300));
      return { id: `turn-${index}`, startedAt, completedAt: startedAt + 60_000, updatedAt: startedAt + 60_000 };
    });
    const { read, requests } = owner(rows, 5_000);
    const merged = await readUsageActivityInPieces(read, { from, to });
    expect(merged.truncated).toBe(false);
    expect(new Set(merged.rows.map((row) => row.line.usageLineId)).size).toBe(rows.length);
    expect(requests.length).toBeLessThan(20);
  });
});
