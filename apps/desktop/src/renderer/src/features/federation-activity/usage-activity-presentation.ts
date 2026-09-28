import type { OwnedUsageRow } from "./usage-activity-summary";

export const usageMoney = (micros: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
  maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
}).format(micros / 1_000_000);
export const usageCount = (value: number) => new Intl.NumberFormat(undefined, {
  notation: "compact", maximumFractionDigits: 1,
}).format(value);
export const usageClock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const USAGE_BUCKETS = 24;
/** Threads beyond this many share the chart's "Other" series. */
export const USAGE_SERIES = 5;

export type UsageBucket = { from: number; to: number; cost: number; rows: number; series: number[]; other: number };

const bucketIndex = (at: number | undefined, from: number, to: number) => {
  if (at === undefined || at < from || at >= to) return undefined;
  return Math.min(USAGE_BUCKETS - 1, Math.floor((at - from) / ((to - from) / USAGE_BUCKETS)));
};
const pricedCost = ({ line }: OwnedUsageRow) => line.priceStatus === "priced" && line.currency === "USD" ? line.totalCostMicros : 0;

/**
 * Whole contained turns are placed at completion; these are not spend-rate
 * buckets. `seriesOf` names a row's chart series (0 to USAGE_SERIES - 1);
 * rows it leaves out stack as Other.
 */
export function usageCompletionBuckets(rows: OwnedUsageRow[], from: number, to: number,
  seriesOf: (row: OwnedUsageRow) => number | undefined = () => undefined): UsageBucket[] {
  const width = (to - from) / USAGE_BUCKETS;
  const buckets = Array.from({ length: USAGE_BUCKETS }, (_, index) => ({
    from: from + index * width, to: from + (index + 1) * width, cost: 0, rows: 0,
    series: Array<number>(USAGE_SERIES).fill(0), other: 0,
  }));
  for (const row of rows) {
    const index = bucketIndex(row.line.completedAt, from, to);
    if (index === undefined) continue;
    const bucket = buckets[index];
    const cost = pricedCost(row);
    bucket.rows += 1;
    bucket.cost += cost;
    const series = seriesOf(row);
    if (series === undefined) bucket.other += cost;
    else bucket.series[series] += cost;
  }
  return buckets;
}

/** A thread's spend per chart bucket, for the row's "when" strip. */
export function usageSpendStrip(rows: OwnedUsageRow[], from: number, to: number): number[] {
  const strip = Array<number>(USAGE_BUCKETS).fill(0);
  for (const row of rows) {
    const index = bucketIndex(row.line.completedAt, from, to);
    if (index !== undefined) strip[index] += pricedCost(row);
  }
  return strip;
}
