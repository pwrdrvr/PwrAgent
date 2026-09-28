import { expect, it } from "vitest";
import { usageCompletionBuckets } from "./usage-activity-presentation";
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
  expect(buckets[15]).toEqual({ from: 150, to: 160, cost: 900, rows: 2 });
  expect(buckets[23].cost).toBe(100);
  expect(buckets.reduce((total, bucket) => total + bucket.cost, 0)).toBe(1000);
});
