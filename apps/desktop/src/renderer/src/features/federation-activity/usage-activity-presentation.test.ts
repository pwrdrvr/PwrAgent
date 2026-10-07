import { expect, it } from "vitest";
import { usageChartStep, usageRollupStep } from "@pwragent/shared";
import { usageBucketBounds, usageBucketLabel, usageCompletionBuckets, usageSpendStrip } from "./usage-activity-presentation";
import { usageFixture } from "./usage-activity-fixture";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();

it("picks the finest clock step that keeps a window within 40 bars", () => {
  expect(usageChartStep(0, 5 * HOUR)).toBe(15 * MINUTE);
  expect(usageChartStep(0, 19 * HOUR)).toBe(30 * MINUTE);
  expect(usageChartStep(0, 35 * HOUR)).toBe(HOUR);
  expect(usageChartStep(0, 7 * 24 * HOUR)).toBe(6 * HOUR);
  expect(usageChartStep(0, 31 * 24 * HOUR)).toBe(24 * HOUR);
  // An owner's helper rollups divide every bar, so none straddles two.
  for (let span = 10 * MINUTE; span <= 31 * 24 * HOUR; span += 17 * MINUTE) {
    expect(usageChartStep(0, span) % usageRollupStep(0, span)).toBe(0);
  }
});

it("starts bars on the clock, leaving only the first and last partial", () => {
  const bounds = usageBucketBounds(at(28, 8, 20), at(29, 19, 13));
  expect(bounds[0]).toEqual({ from: at(28, 8, 20), to: at(28, 9) });
  expect(bounds[1]).toEqual({ from: at(28, 9), to: at(28, 10) });
  expect(bounds.at(-1)).toEqual({ from: at(29, 19), to: at(29, 19, 13) });
  expect(bounds.slice(1, -1).every((bound) => bound.to - bound.from === HOUR && new Date(bound.from).getMinutes() === 0)).toBe(true);
  const week = usageBucketBounds(at(22, 19, 13), at(29, 19, 13));
  expect(week[1]).toEqual({ from: at(23, 0), to: at(23, 6) });
});

it("names a bar by its hours, and by its day when that is not today", () => {
  expect(usageBucketLabel({ from: at(29, 14), to: at(29, 15) }, at(29, 19))).toMatch(/^2\sPM–3\sPM$/);
  expect(usageBucketLabel({ from: at(28, 14), to: at(28, 15) }, at(29, 19))).toMatch(/Sep 28.*2\sPM–3\sPM$/);
  expect(usageBucketLabel({ from: at(28, 0), to: at(29, 0) }, at(29, 19))).toMatch(/Sep 28$/);
});

it("places a whole turn at completion rather than smearing its price across time", () => {
  const from = at(28, 0);
  const buckets = usageCompletionBuckets([
    usageFixture({ startedAt: from, completedAt: from + 150 * MINUTE, totalCostMicros: 900 }),
    usageFixture({ completedAt: from + 239 * MINUTE, totalCostMicros: 100 }),
    usageFixture({ completedAt: from + 240 * MINUTE, totalCostMicros: 999 }),
    usageFixture({ completedAt: undefined, totalCostMicros: 999 }),
    usageFixture({ completedAt: from + 151 * MINUTE, priceStatus: "unpriced", totalCostMicros: 999 }),
  ], from, from + 4 * HOUR);
  expect(buckets).toHaveLength(16);
  expect(buckets[0].cost).toBe(0);
  expect(buckets[10]).toEqual({ from: from + 150 * MINUTE, to: from + 165 * MINUTE, cost: 900, rows: 2, series: [0, 0, 0, 0, 0], other: 900,
    members: [{ key: JSON.stringify(["Local", "codex", "thread"]), cost: 900, rows: 2, threads: 1, owners: ["Local"] }] });
  expect(buckets[15].cost).toBe(100);
  expect(buckets.reduce((total, bucket) => total + bucket.cost, 0)).toBe(1000);
});

it("stacks each bucket by the series a row belongs to", () => {
  const from = at(28, 0);
  const rows = [
    usageFixture({ threadId: "a", completedAt: from + 5, totalCostMicros: 400 }),
    usageFixture({ threadId: "b", completedAt: from + 6, totalCostMicros: 100 }),
    usageFixture({ threadId: "c", completedAt: from + 7, totalCostMicros: 50 }),
  ];
  const [first] = usageCompletionBuckets(rows, from, from + 4 * HOUR, (row) => ({ a: 0, b: 1 } as Record<string, number>)[row.line.threadId]);
  expect(first).toMatchObject({ cost: 550, series: [400, 100, 0, 0, 0], other: 50 });
  expect(usageSpendStrip(rows.slice(0, 1), from, from + 4 * HOUR).slice(0, 2)).toEqual([400, 0]);
});

it("names what each bucket stacks, with the turns and threads behind every segment", () => {
  const from = at(28, 0);
  const row = (threadId: string, model: string, totalCostMicros: number, owner = "Local") =>
    ({ ...usageFixture({ threadId, usageLineId: `${threadId}-${model}-${totalCostMicros}`, model, completedAt: from + 5, totalCostMicros }), owner });
  const rows = [row("a", "gpt", 400), row("a", "gpt", 100), row("b", "gpt", 50, "Peer"), row("c", "grok", 30), row("d", "kimi", 20)];
  const [first] = usageCompletionBuckets(rows, from, from + 4 * HOUR, (item) => item.line.model === "gpt" ? 0 : undefined,
    (item) => ({ key: item.line.model!, thread: item.line.threadId }));
  // The bars and the card read the same rows: every member sums to the bar.
  expect(first).toMatchObject({ cost: 600, rows: 5, series: [550, 0, 0, 0, 0], other: 50 });
  expect(first.members).toEqual([
    { key: "gpt", series: 0, cost: 550, rows: 3, threads: 2, owners: ["Local", "Peer"] },
    { key: "grok", cost: 30, rows: 1, threads: 1, owners: ["Local"] },
    { key: "kimi", cost: 20, rows: 1, threads: 1, owners: ["Local"] },
  ]);
  expect(first.members.reduce((total, member) => total + member.cost, 0)).toBe(first.cost);
});
