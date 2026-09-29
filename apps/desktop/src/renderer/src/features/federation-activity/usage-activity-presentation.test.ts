import { expect, it } from "vitest";
import { usageCompletionBuckets, usageSpendStrip } from "./usage-activity-presentation";
import { usageFixture } from "./usage-activity-fixture";

it("places a whole turn at completion rather than smearing its price across time", () => {
  const buckets = usageCompletionBuckets([
    usageFixture({ startedAt: 0, completedAt: 150, totalCostMicros: 900 }),
    usageFixture({ completedAt: 239, totalCostMicros: 100 }),
    usageFixture({ completedAt: 240, totalCostMicros: 999 }),
    usageFixture({ completedAt: undefined, totalCostMicros: 999 }),
    usageFixture({ completedAt: 151, priceStatus: "unpriced", totalCostMicros: 999 }),
  ], 0, 240);
  expect(buckets[0].cost).toBe(0);
  expect(buckets[15]).toEqual({ from: 150, to: 160, cost: 900, rows: 2, series: [0, 0, 0, 0, 0], other: 900 });
  expect(buckets[23].cost).toBe(100);
  expect(buckets.reduce((total, bucket) => total + bucket.cost, 0)).toBe(1000);
});

it("stacks each bucket by the series a row belongs to", () => {
  const rows = [
    usageFixture({ threadId: "a", completedAt: 5, totalCostMicros: 400 }),
    usageFixture({ threadId: "b", completedAt: 6, totalCostMicros: 100 }),
    usageFixture({ threadId: "c", completedAt: 7, totalCostMicros: 50 }),
  ];
  const [first] = usageCompletionBuckets(rows, 0, 240, (row) => ({ a: 0, b: 1 } as Record<string, number>)[row.line.threadId]);
  expect(first).toMatchObject({ cost: 550, series: [400, 100, 0, 0, 0], other: 50 });
  expect(usageSpendStrip(rows.slice(0, 1), 0, 240).slice(0, 2)).toEqual([400, 0]);
});
