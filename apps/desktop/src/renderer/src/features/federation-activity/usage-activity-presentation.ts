import type { OwnedUsageRow } from "./usage-activity-summary";

export const usageMoney = (micros: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
  maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
}).format(micros / 1_000_000);
export const usageCount = (value: number) => new Intl.NumberFormat(undefined, {
  notation: "compact", maximumFractionDigits: 1,
}).format(value);
export const usageClock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** Whole contained turns are placed at completion; these are not spend-rate buckets. */
export function usageCompletionBuckets(rows: OwnedUsageRow[], from: number, to: number) {
  const width = (to - from) / 24;
  const buckets = Array.from({ length: 24 }, (_, index) => ({
    from: from + index * width, to: from + (index + 1) * width, cost: 0, rows: 0,
  }));
  for (const { line } of rows) {
    if (line.completedAt === undefined || line.completedAt < from || line.completedAt >= to) continue;
    const bucket = buckets[Math.floor((line.completedAt - from) / width)];
    bucket.rows += 1;
    if (line.priceStatus === "priced" && line.currency === "USD") bucket.cost += line.totalCostMicros;
  }
  return buckets;
}
