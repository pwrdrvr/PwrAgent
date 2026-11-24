import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ResourceSharing, ResourceUsageHistory } from "@pwragent/shared/contracts/resource-checkouts";
import { usageChart } from "../resource-usage";

/**
 * The rules the 30-minute chart's bars must keep:
 *
 * - Bars are fixed and clock-aligned: the last one holds `now` (or the
 *   newest point, when a snapshot lands between clock ticks), and each
 *   covers exactly one bucket, so the chart only moves a whole bar at a time.
 * - A bar is the busiest single moment of its bucket — the most held plus
 *   waiting, then the most held — evaluated on the step function from the
 *   bucket's start (or `observedSince`) through the bucket's end or now.
 *   Held and waiting therefore never come from two different moments.
 * - A bar wholly before `observedSince` is unobserved and empty.
 * - The scale never cuts a bar or the capacity line.
 *
 * The oracle evaluates the step function at every instant where it can
 * change inside each bucket.
 */

const BUCKET = 1_000;
const WINDOW = 12_000;
const T0 = 1_800_000_000_000;

const history = fc.record({
  observedOffset: fc.integer({ min: -20_000, max: 15_000 }),
  steps: fc.array(
    fc.record({ gap: fc.integer({ min: 1, max: 2_500 }), held: fc.nat({ max: 6 }), waiting: fc.nat({ max: 6 }) }),
    { minLength: 1, maxLength: 40 },
  ),
  lag: fc.integer({ min: -2_000, max: 4_000 }),
  sharing: fc.oneof(
    fc.constant<ResourceSharing>({ mode: "exclusive" }),
    fc.integer({ min: 1, max: 8 }).map<ResourceSharing>((capacity) => ({ mode: "counted", capacity, inUse: 0, unitLabel: "slots" })),
  ),
});

function valueAt(usage: ResourceUsageHistory, at: number) {
  return usage.points.filter((point) => point.at <= at).at(-1);
}

describe("usageChart", () => {
  it("draws each bucket's busiest observed moment", () => {
    fc.assert(fc.property(history, ({ observedOffset, steps, lag, sharing }) => {
      let at = T0;
      const points = steps.map(({ gap, held, waiting }) => ({ at: (at += gap), held, waiting }));
      const observedSince = Math.min(points[0].at, T0 + observedOffset);
      const usage: ResourceUsageHistory = { observedSince: Math.max(observedSince, T0), points };
      const clock = points[points.length - 1].at + lag;
      const chart = usageChart({ sharing, usage }, clock, { windowMs: WINDOW, bucketMs: BUCKET })!;
      const now = Math.max(clock, points[points.length - 1].at);

      expect(chart.bars).toHaveLength(WINDOW / BUCKET);
      const last = chart.bars[chart.bars.length - 1];
      expect(last.startAt).toBeLessThanOrEqual(now);
      expect(last.endAt).toBeGreaterThan(now);
      for (const [index, bar] of chart.bars.entries()) {
        expect(bar.startAt % BUCKET).toBe(0);
        expect(bar.endAt - bar.startAt).toBe(BUCKET);
        if (index > 0) expect(bar.startAt).toBe(chart.bars[index - 1].endAt);

        const from = Math.max(bar.startAt, usage.observedSince);
        const to = Math.min(bar.endAt - 1, now);
        expect(bar.observed).toBe(bar.endAt > usage.observedSince);
        if (!bar.observed || from > to) {
          expect([bar.held, bar.waiting]).toEqual([0, 0]);
          continue;
        }
        const moments = [from, ...points.map((point) => point.at).filter((moment) => moment > from && moment <= to)];
        let best = { held: 0, waiting: 0 };
        let seen = false;
        for (const moment of moments) {
          const value = valueAt(usage, moment);
          if (!value) continue;
          const total = value.held + value.waiting - (best.held + best.waiting);
          if (!seen || total > 0 || (total === 0 && value.held > best.held)) best = value;
          seen = true;
        }
        expect({ held: bar.held, waiting: bar.waiting }).toEqual({ held: best.held, waiting: best.waiting });
        expect(chart.scaleMax).toBeGreaterThanOrEqual(bar.held + bar.waiting);
      }
      expect(chart.scaleMax).toBeGreaterThanOrEqual(chart.capacity);
      expect(chart.capacity).toBe(sharing.mode === "counted" ? sharing.capacity : 1);
    }));
  });

  it("draws nothing without history", () => {
    expect(usageChart({ sharing: { mode: "exclusive" } }, T0)).toBeUndefined();
    expect(usageChart({ sharing: { mode: "exclusive" }, usage: { observedSince: T0, points: [] } }, T0)).toBeUndefined();
  });
});
