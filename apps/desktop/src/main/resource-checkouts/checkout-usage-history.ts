import {
  RESOURCE_USAGE_WINDOW_MS,
  type ResourceCondition,
  type ResourceDomain,
  type ResourceUsageHistory,
  type ResourceUsagePoint,
} from "@pwragent/shared/contracts/resource-checkouts";

/**
 * Bounds a series even when every observation changes it: 30 minutes of the
 * 2-second poll is 900, and operator reads between polls add a few more.
 */
export const MAX_USAGE_POINTS = 1_024;

/** No authority answered, so the resource's projection is not an observation. */
const UNOBSERVED: ReadonlySet<ResourceCondition> = new Set(["unreachable", "ownership_unresolved"]);

type Series = { observedSince: number; lastSeenAt: number; points: ResourceUsagePoint[] };

export function usageUnits(resource: ResourceDomain): Omit<ResourceUsagePoint, "at"> {
  let held = 0;
  let waiting = 0;
  for (const allocation of resource.allocations) held += allocation.units ?? 1;
  for (const entry of resource.queue) waiting += entry.units ?? 1;
  return { held, waiting };
}

/**
 * What this process saw of each resource over the last 30 minutes, as a
 * step function of held and waiting units. It lives in memory only: the
 * checkout store keeps current grants and queues, not history, and this adds
 * no reads or writes to it. Each observation costs one comparison per
 * resource and appends a point only when a value changes.
 */
export class ResourceUsageRecorder {
  private readonly series = new Map<string, Series>();

  constructor(private readonly windowMs = RESOURCE_USAGE_WINDOW_MS) {}

  observe(resources: readonly ResourceDomain[], now: number): void {
    for (const resource of resources) {
      const series = this.series.get(resource.resourceId);
      if (series) series.lastSeenAt = Math.max(series.lastSeenAt, now);
      if (!UNOBSERVED.has(resource.condition) && !resource.allocations.some(({ lastKnown }) => lastKnown)) {
        const units = usageUnits(resource);
        if (series) record(series.points, now, units);
        else this.series.set(resource.resourceId, { observedSince: now, lastSeenAt: now, points: [{ at: now, ...units }] });
      }
      if (series) this.prune(series, now);
    }
    for (const [resourceId, series] of this.series) {
      if (now - series.lastSeenAt > this.windowMs) this.series.delete(resourceId);
    }
  }

  history(resourceId: string): ResourceUsageHistory | undefined {
    const series = this.series.get(resourceId);
    return series ? { observedSince: series.observedSince, points: series.points.slice() } : undefined;
  }

  /** Keeps the one point in force at the window's start, and nothing older. */
  private prune(series: Series, now: number): void {
    const { points } = series;
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop + 1 < points.length && points[drop + 1].at <= cutoff) drop += 1;
    drop = Math.max(drop, points.length - MAX_USAGE_POINTS);
    if (drop === 0) return;
    points.splice(0, drop);
    // The cap dropped a point inside the window: what preceded the new first
    // point is no longer known.
    if (points[0].at > cutoff) series.observedSince = Math.max(series.observedSince, points[0].at);
  }
}

function record(points: ResourceUsagePoint[], now: number, { held, waiting }: Omit<ResourceUsagePoint, "at">): void {
  const last = points[points.length - 1];
  // A read can carry an older clock than the poll before it; the step
  // function stays ordered.
  if (now < last.at || (last.held === held && last.waiting === waiting)) return;
  // A second observation in the same millisecond supersedes the first.
  if (last.at === now && points.length > 1) points.pop();
  const before = points[points.length - 1];
  if (before.at === now) points[points.length - 1] = { at: now, held, waiting };
  else if (before.held !== held || before.waiting !== waiting) points.push({ at: now, held, waiting });
}
