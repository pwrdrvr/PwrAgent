import { usageActivityCoverage, usageChartStep, type UsageActivityRollup } from "@pwragent/shared";
import type { OwnedUsageRow } from "./usage-activity-summary";
import { formatUsedPercent as usagePercent } from "../../lib/backend-status-format";
import { projectLimit, type LimitProjection, type LimitSeries } from "./usage-limits";

export const usageMoney = (micros: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
  maximumFractionDigits: micros > 0 && micros < 10_000 ? 4 : 2,
}).format(micros / 1_000_000);
export const usageCount = (value: number) => new Intl.NumberFormat(undefined, {
  notation: "compact", maximumFractionDigits: 1,
}).format(value);
export const usageClock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The clock time today; beyond today "Tue, Oct 6, 10 PM", or "Tue 10 PM" when
 * `compact` (a rail) and within the coming week.
 */
export function usageWhen(at: number, now: number, compact = false) {
  const date = new Date(at);
  if (date.toDateString() === new Date(now).toDateString()) return usageClock(at);
  if (compact && Math.abs(at - now) < 6 * DAY) {
    return date.toLocaleString(undefined, { weekday: "short", hour: "numeric" });
  }
  return date.toLocaleString(undefined, compact
    ? { month: "short", day: "numeric" }
    : { weekday: "short", month: "short", day: "numeric", hour: "numeric" });
}

export function usageDuration(ms: number) {
  const hours = Math.floor(ms / HOUR);
  const minutes = Math.round((ms % HOUR) / 60_000);
  if (hours >= 36) return `${Math.round(hours / 24)} days`;
  return hours ? `${hours} h ${minutes} m` : `${minutes} m`;
}

export { formatUsedPercent as usagePercent } from "../../lib/backend-status-format";

/**
 * Where a limit's pace lands, in the words every surface uses. `short` is the
 * one outcome worth a warning: running out before the reset.
 */
export function describeLimitPace(series: LimitSeries, now: number, compact = false):
  { rate: string; text: string; short: boolean; projection: LimitProjection } | undefined {
  const projection = projectLimit(series);
  if (series.pacePerHour === undefined || !projection) return undefined;
  const { latest } = series;
  const short = projection.kind === "full" && latest.resetAt !== undefined;
  const text = projection.kind === "atReset"
    ? `On pace for about ${Math.round(projection.percent)}% at the ${usageWhen(projection.resetAt, now, compact)} reset`
    : short
      ? `On pace to reach 100% ${usageWhen(projection.at, now, compact)}, ${usageDuration(latest.resetAt! - projection.at)} before the reset`
      : `At this pace, 100% in about ${usageDuration(projection.at - latest.at)} (${usageWhen(projection.at, now, compact)})`;
  return { rate: `+${usagePercent(series.pacePerHour)}%/h`, text, short, projection };
}

/** Why a row sits outside the window's total, in the words the list shows. */
export function usageNotCountedReason(row: OwnedUsageRow, from: number, to: number): string {
  if (usageActivityCoverage(row, from, to) === "unattributed") return "Not attributed to a turn";
  const start = row.line.startedAt ?? row.line.createdAt;
  if (row.line.completedAt === undefined) return "Still running, or its end was never recorded";
  if (start < from) return "Started before this period";
  return "Finished after this period";
}

const ROLLUP_LABELS: Record<string, string> = {
  "token-miser": "Token Miser", "token-miser-focused": "Token Miser, focused", "title-helper": "Title helper",
  "queued-message-titles": "Queued message titles",
};
/** "Token Miser · 42 runs" for a summed background-helper line. */
export function usageRollupLabel(rollup: UsageActivityRollup): string {
  return `${ROLLUP_LABELS[rollup.kind] ?? rollup.kind} · ${rollup.count} ${rollup.count === 1 ? "run" : "runs"}`;
}

/** Threads beyond this many share the chart's "Other" series. */
export const USAGE_SERIES = 5;

/** What the chart stacks spend by. */
export type UsageDimension = "thread" | "model" | "provider" | "instance";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", xai: "xAI", anthropic: "Anthropic", google: "Google", moonshot: "Moonshot", qwen: "Qwen",
};

/** A row's model, provider or owning instance, as the legend names it. */
export function usageDimensionValue(row: OwnedUsageRow, dimension: Exclude<UsageDimension, "thread">): string {
  if (dimension === "instance") return row.owner;
  if (dimension === "provider") return PROVIDER_LABELS[row.line.provider] ?? row.line.provider;
  return row.line.modelLabel ?? row.line.model ?? "Unknown model";
}

/**
 * One thread, model, provider or instance in a bucket: its priced spend, its
 * completed turns, the threads those turns belong to, and their instances.
 * `series` is its chart color; a member without one stacks as Other.
 */
export type UsageBucketMember = { key: string; series?: number; cost: number; rows: number; threads: number; owners: string[] };
export type UsageBucket = {
  from: number; to: number; cost: number; rows: number; series: number[]; other: number;
  /** Everything stacked in the bucket, the most expensive first. */
  members: UsageBucketMember[];
};

/** The local clock boundary at or before `at` for a bar of `step`. */
function alignDown(at: number, step: number): number {
  const date = new Date(at);
  if (step >= DAY) date.setHours(0, 0, 0, 0);
  else if (step >= HOUR) date.setHours(Math.floor(date.getHours() / (step / HOUR)) * (step / HOUR), 0, 0, 0);
  else date.setMinutes(Math.floor(date.getMinutes() / (step / 60_000)) * (step / 60_000), 0, 0);
  return date.getTime();
}

/** The next boundary, by the calendar so a DST change keeps bars on the clock. */
function nextBoundary(at: number, step: number): number {
  const date = new Date(at);
  if (step >= DAY) date.setDate(date.getDate() + 1);
  else if (step >= HOUR) date.setHours(date.getHours() + step / HOUR);
  else return at + step;
  return date.getTime();
}

/**
 * The chart's bars for a window: clock-aligned steps from `usageChartStep`,
 * so a bar is "2–3 PM" or "Tue", never an arbitrary 84-minute slice. Only the
 * first and last bars can be partial.
 */
export function usageBucketBounds(from: number, to: number): Array<{ from: number; to: number }> {
  const step = usageChartStep(from, to);
  const bounds: Array<{ from: number; to: number }> = [];
  for (let start = alignDown(from, step); start < to;) {
    const end = Math.max(nextBoundary(start, step), start + 60_000);
    bounds.push({ from: Math.max(from, start), to: Math.min(to, end) });
    start = end;
  }
  return bounds;
}

const bucketIndex = (at: number | undefined, bounds: Array<{ from: number; to: number }>) => {
  if (at === undefined) return undefined;
  const index = bounds.findIndex((bound) => at >= bound.from && at < bound.to);
  return index < 0 ? undefined : index;
};

const hourText = (at: number) => {
  const date = new Date(at);
  return date.toLocaleTimeString(undefined, date.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });
};
const dayText = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "2 PM–3 PM", with the day when it is not `today`'s, or the day alone for a whole-day bar. */
export function usageBucketLabel(bucket: { from: number; to: number }, today: number): string {
  const start = new Date(bucket.from);
  if (start.getHours() === 0 && start.getMinutes() === 0 && bucket.to - bucket.from >= DAY - HOUR) return dayText(bucket.from);
  const range = `${hourText(bucket.from)}–${hourText(bucket.to)}`;
  return start.toDateString() === new Date(today).toDateString() ? range : `${dayText(bucket.from)}, ${range}`;
}
const pricedCost = ({ line }: OwnedUsageRow) => line.priceStatus === "priced" && line.currency === "USD" ? line.totalCostMicros : 0;

/**
 * Whole contained turns are placed at completion; these are not spend-rate
 * buckets. `seriesOf` names a row's chart series (0 to USAGE_SERIES - 1);
 * rows it leaves out stack as Other. `memberOf` names the thread, model,
 * provider or instance a row stacks under, and the thread it belongs to.
 */
export function usageCompletionBuckets(rows: OwnedUsageRow[], from: number, to: number,
  seriesOf: (row: OwnedUsageRow) => number | undefined = () => undefined,
  memberOf: (row: OwnedUsageRow) => { key: string; thread: string } = (row) => {
    const thread = JSON.stringify([row.owner, row.line.backend, row.line.threadId]);
    return { key: thread, thread };
  }): UsageBucket[] {
  const bounds = usageBucketBounds(from, to);
  const buckets = bounds.map((bound) => ({ ...bound, cost: 0, rows: 0, series: Array<number>(USAGE_SERIES).fill(0), other: 0,
    members: [] as UsageBucketMember[] }));
  const members = bounds.map(() => new Map<string, UsageBucketMember & { threadKeys: Set<string>; ownerNames: Set<string> }>());
  for (const row of rows) {
    const index = bucketIndex(row.line.completedAt, bounds);
    if (index === undefined) continue;
    const bucket = buckets[index];
    const cost = pricedCost(row);
    bucket.rows += 1;
    bucket.cost += cost;
    const series = seriesOf(row);
    if (series === undefined) bucket.other += cost;
    else bucket.series[series] += cost;
    const { key, thread } = memberOf(row);
    let member = members[index].get(key);
    if (!member) {
      member = { key, series, cost: 0, rows: 0, threads: 0, owners: [], threadKeys: new Set(), ownerNames: new Set() };
      members[index].set(key, member);
    }
    member.cost += cost;
    member.rows += 1;
    member.threadKeys.add(thread);
    member.ownerNames.add(row.owner);
  }
  buckets.forEach((bucket, index) => {
    bucket.members = [...members[index].values()]
      .map(({ threadKeys, ownerNames, ...member }) => ({ ...member, threads: threadKeys.size, owners: [...ownerNames] }))
      .sort((a, b) => b.cost - a.cost);
  });
  return buckets;
}

/** A thread's spend per chart bucket, for the row's "when" strip. */
export function usageSpendStrip(rows: OwnedUsageRow[], from: number, to: number): number[] {
  const bounds = usageBucketBounds(from, to);
  const strip = Array<number>(bounds.length).fill(0);
  for (const row of rows) {
    const index = bucketIndex(row.line.completedAt, bounds);
    if (index !== undefined) strip[index] += pricedCost(row);
  }
  return strip;
}
