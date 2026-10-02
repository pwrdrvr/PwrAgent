import type { UsageLimitObservation, UsageLimitReading } from "@pwragent/shared";

/** One owner's limit readings, as returned by its usage read. */
export type LimitSource = { owner: string; current?: UsageLimitObservation; history?: UsageLimitObservation[] };

export type LimitPoint = { at: number; usedPercent: number; used?: number; limit?: number; resetAt?: number };

/**
 * A limit went back down between two readings. `scheduled` means the earlier
 * reading's reset time had passed; anything else is a reset nobody announced
 * (the provider or the operator applied one), placed where it was first seen.
 */
export type LimitReset = { at: number; kind: "scheduled" | "unscheduled"; after: number; before: number };

export type LimitSeries = {
  key: string;
  name: string;
  windowKey?: UsageLimitReading["windowKey"];
  windowMinutes?: number;
  points: LimitPoint[];
  resets: LimitReset[];
  latest: LimitPoint;
  /** When the current window began, from the newest reset evidence. */
  windowStart?: number;
  /** Average percent per hour since `windowStart`; usage is zero at a reset. */
  pacePerHour?: number;
};

export type LimitAccount = {
  key: string;
  planType?: string;
  owners: string[];
  observedAt: number;
  observedBy: string;
  series: LimitSeries[];
  credits?: { hasCredits?: boolean; unlimited?: boolean };
};

/** Percent drops smaller than this are rounding noise, not a reset. */
const RESET_DROP_PERCENT = 1;
const HOUR = 3_600_000;
/** A pace over less than this is too noisy to project from. */
const MIN_PACE_SPAN = 30 * 60_000;

const seriesKey = (limit: UsageLimitReading) =>
  JSON.stringify([limit.windowKey ?? "", limit.limitId ?? "", limit.windowKey ? "" : limit.name]);

/** The recorded series for one current limit reading, if the account has one. */
export function limitSeriesFor(account: LimitAccount | undefined, limit: UsageLimitReading): LimitSeries | undefined {
  const key = seriesKey(limit);
  return account?.series.find((series) => series.key === key);
}

/**
 * Group owners' readings by account, never blending two accounts. Readings
 * without an account key stay with their own owner.
 */
export function buildLimitAccounts(sources: LimitSource[]): LimitAccount[] {
  const accounts = new Map<string, { planType?: string; owners: Set<string>; observations: Array<UsageLimitObservation & { owner: string }> }>();
  for (const source of sources) {
    for (const observation of [...source.history ?? [], ...source.current ? [source.current] : []]) {
      const key = observation.accountKey ? `account:${observation.accountKey}` : `owner:${source.owner}`;
      let account = accounts.get(key);
      if (!account) accounts.set(key, account = { owners: new Set(), observations: [] });
      account.owners.add(source.owner);
      account.planType ??= observation.planType;
      account.observations.push({ ...observation, owner: source.owner });
    }
  }
  return [...accounts.entries()].map(([key, account]) => {
    const observations = account.observations.sort((a, b) => a.observedAt - b.observedAt);
    const newest = observations.at(-1)!;
    const byLimit = new Map<string, { reading: UsageLimitReading; points: LimitPoint[] }>();
    let credits: LimitAccount["credits"];
    for (const observation of observations) {
      for (const limit of observation.limits) {
        if (limit.windowKey === "credits") {
          credits = { hasCredits: limit.hasCredits, unlimited: limit.unlimited };
          continue;
        }
        if (limit.usedPercent === undefined) continue;
        const id = seriesKey(limit);
        let entry = byLimit.get(id);
        if (!entry) byLimit.set(id, entry = { reading: limit, points: [] });
        entry.reading = limit;
        const last = entry.points.at(-1);
        const point = { at: observation.observedAt, usedPercent: limit.usedPercent, used: limit.used, limit: limit.limit, resetAt: limit.resetAt };
        // Several owners can relay the same account reading.
        if (last && last.at === point.at) entry.points[entry.points.length - 1] = point;
        else entry.points.push(point);
      }
    }
    const series = [...byLimit.entries()].map(([id, { reading, points }]) => describeSeries(id, reading, points))
      .sort((a, b) => windowOrder(a) - windowOrder(b));
    return { key, planType: account.planType, owners: [...account.owners], observedAt: newest.observedAt,
      observedBy: newest.owner, series, credits };
  }).sort((a, b) => b.observedAt - a.observedAt);
}

function windowOrder(series: LimitSeries) {
  return series.windowKey === "primary" ? 0 : series.windowKey === "secondary" ? 1 : series.windowKey === "individual" ? 2 : 3;
}

function describeSeries(key: string, reading: UsageLimitReading, points: LimitPoint[]): LimitSeries {
  const resets: LimitReset[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    const dropped = after.usedPercent < before.usedPercent - RESET_DROP_PERCENT;
    const elapsed = before.resetAt !== undefined && before.resetAt <= after.at;
    // A window that elapsed and filled back up past its old level still reset.
    if (!dropped && !(elapsed && after.resetAt !== undefined && after.resetAt > before.resetAt!)) continue;
    resets.push(elapsed
      ? { at: before.resetAt!, kind: "scheduled", after: before.at, before: after.at }
      : { at: after.at, kind: "unscheduled", after: before.at, before: after.at });
  }
  const latest = points.at(-1)!;
  const lastReset = resets.at(-1);
  // The provider's schedule says when this window began; a later reset we saw
  // happen wins, since usage restarts from zero at any reset.
  const scheduledStart = latest.resetAt !== undefined && reading.windowMinutes
    ? latest.resetAt - reading.windowMinutes * 60_000 : undefined;
  const windowStart = [scheduledStart, lastReset?.at].filter((at): at is number => at !== undefined && at <= latest.at)
    .reduce<number | undefined>((best, at) => best === undefined || at > best ? at : best, undefined);
  let pacePerHour: number | undefined;
  if (windowStart !== undefined && latest.at - windowStart >= MIN_PACE_SPAN) {
    pacePerHour = latest.usedPercent / ((latest.at - windowStart) / HOUR);
  } else {
    // No known start: fall back to the slope across this window's readings.
    const segment = points.filter((point) => lastReset === undefined || point.at >= lastReset.before);
    const first = segment[0];
    if (first && latest.at - first.at >= MIN_PACE_SPAN) {
      pacePerHour = Math.max(0, latest.usedPercent - first.usedPercent) / ((latest.at - first.at) / HOUR);
    }
  }
  return { key, name: reading.name, windowKey: reading.windowKey, windowMinutes: reading.windowMinutes, points, resets,
    latest, windowStart, pacePerHour };
}

/** The limit a "since reset" window follows: the longest one the account has. */
export function sinceResetSeries(account: LimitAccount | undefined): LimitSeries | undefined {
  if (!account) return undefined;
  return account.series.find((series) => series.windowKey === "individual")
    ?? account.series.find((series) => series.windowKey === "secondary")
    ?? account.series.at(-1);
}

export function fiveHourSeries(account: LimitAccount | undefined): LimitSeries | undefined {
  return account?.series.find((series) => series.windowKey === "primary");
}

/**
 * When a window without a stated length began: an individual (credit) limit
 * resets monthly, so step back one calendar month from its reset.
 */
export function seriesStart(series: LimitSeries | undefined): number | undefined {
  if (!series) return undefined;
  if (series.windowStart !== undefined) return series.windowStart;
  if (series.windowKey === "individual" && series.latest.resetAt !== undefined) {
    const start = new Date(series.latest.resetAt);
    start.setMonth(start.getMonth() - 1);
    return start.getTime();
  }
  return undefined;
}

export type LimitProjection =
  | { kind: "full"; at: number }
  | { kind: "atReset"; percent: number; resetAt: number };

/** Where this pace lands: full before the reset, or the level at the reset. */
export function projectLimit(series: LimitSeries): LimitProjection | undefined {
  const pace = series.pacePerHour;
  if (!pace || pace <= 0) return undefined;
  const { latest } = series;
  const fullAt = latest.at + (100 - latest.usedPercent) / pace * HOUR;
  if (latest.resetAt !== undefined && fullAt > latest.resetAt) {
    return { kind: "atReset", percent: Math.min(100, latest.usedPercent + pace * (latest.resetAt - latest.at) / HOUR), resetAt: latest.resetAt };
  }
  return { kind: "full", at: fullAt };
}

export function limitLabel(series: LimitSeries): string {
  if (series.windowKey === "primary" && series.windowMinutes === 300) return "5-hour window";
  if (series.windowKey === "secondary" && series.windowMinutes === 10_080) return "Weekly limit";
  if (series.windowKey === "individual") return "Individual limit";
  return series.name;
}
