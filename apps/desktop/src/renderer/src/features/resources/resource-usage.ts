import {
  RESOURCE_USAGE_WINDOW_MS,
  type ResourceDomain,
  type ResourceUsageHistory,
  type ResourceUsagePoint,
} from "@pwragent/shared/contracts/resource-checkouts";

/** One bar per 30 seconds, matching the screen's clock tick. */
export const USAGE_BUCKET_MS = 30_000;

export type UsageBar = {
  startAt: number;
  endAt: number;
  /**
   * The busiest moment in the bucket (most held plus waiting, then most
   * held), so a stacked bar is one state that actually happened rather than
   * two peaks from different moments.
   */
  held: number;
  waiting: number;
  /** False before this viewer's process first saw the resource. */
  observed: boolean;
};

export type UsageChart = {
  bars: UsageBar[];
  /** Counted capacity, or one for an exclusive resource. */
  capacity: number;
  /** The y-axis top: capacity, or more when requests exceed it. */
  scaleMax: number;
  peakHeld: number;
  peakWaiting: number;
  /** When the first observed bar begins, if the window starts unobserved. */
  observedSince?: number;
};

/**
 * Buckets a step-function history into fixed, clock-aligned bars ending at
 * the bucket that holds `now`. The last point holds until `now`: the
 * serving process publishes a new revision whenever a value changes. One
 * pass over points and bars.
 */
export function usageChart(
  resource: Pick<ResourceDomain, "sharing"> & { usage?: ResourceUsageHistory },
  clock: number,
  options: { windowMs?: number; bucketMs?: number } = {},
): UsageChart | undefined {
  const usage = resource.usage;
  if (!usage || usage.points.length === 0) return undefined;
  // A snapshot can arrive between the screen's clock ticks; its points are
  // never in the future.
  const now = Math.max(clock, usage.points[usage.points.length - 1].at);
  const bucketMs = options.bucketMs ?? USAGE_BUCKET_MS;
  const count = Math.max(1, Math.round((options.windowMs ?? RESOURCE_USAGE_WINDOW_MS) / bucketMs));
  const end = (Math.floor(now / bucketMs) + 1) * bucketMs;
  const start = end - count * bucketMs;
  const { points, observedSince } = usage;
  const bars: UsageBar[] = [];
  let next = 0;
  // The value in force at the cursor; undefined before the first point.
  let current: ResourceUsagePoint | undefined;
  let peakHeld = 0;
  let peakWaiting = 0;
  for (let index = 0; index < count; index += 1) {
    const startAt = start + index * bucketMs;
    const endAt = startAt + bucketMs;
    const from = Math.max(startAt, observedSince);
    while (next < points.length && points[next].at <= from) current = points[next++];
    let best: { held: number; waiting: number } | undefined = from < Math.min(endAt, now + 1) ? current : undefined;
    while (next < points.length && points[next].at < endAt) {
      current = points[next++];
      if (current.at > now) continue;
      if (!best || busier(current, best)) best = current;
    }
    const observed = endAt > observedSince && startAt <= now;
    const held = observed && best ? best.held : 0;
    const waiting = observed && best ? best.waiting : 0;
    peakHeld = Math.max(peakHeld, held);
    peakWaiting = Math.max(peakWaiting, waiting);
    bars.push({ startAt, endAt, held, waiting, observed });
  }
  const capacity = resource.sharing.mode === "counted" ? resource.sharing.capacity : 1;
  const scaleMax = Math.max(capacity, ...bars.map((bar) => bar.held + bar.waiting), 1);
  return {
    bars, capacity, scaleMax, peakHeld, peakWaiting,
    ...(observedSince > start ? { observedSince } : {}),
  };
}

function busier(a: { held: number; waiting: number }, b: { held: number; waiting: number }): boolean {
  const total = a.held + a.waiting - (b.held + b.waiting);
  return total > 0 || (total === 0 && a.held > b.held);
}
