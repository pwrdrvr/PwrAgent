import type { UsageLimitObservation, UsageLimitReading } from "@pwragent/shared/contracts/usage-activity";
import { federationTargetKey, type FederationTarget } from "@pwragent/shared/contracts/federation";

/**
 * One owner's limit readings, as returned by its usage read. An owner can
 * hold a current reading for each provider it runs.
 */
export type LimitSource = {
  owner: string;
  target: FederationTarget;
  current?: UsageLimitObservation | UsageLimitObservation[];
  history?: UsageLimitObservation[];
};

export type LimitPoint = {
  at: number; usedPercent: number; used?: number; limit?: number; resetAt?: number;
  /** `resetAt` ends the allowance (a credit grant) instead of renewing it. */
  expires?: boolean;
};

/** The ledger provider a reading describes; older owners reported OpenAI's (Codex) only. */
export const limitProvider = (observation: Pick<UsageLimitObservation, "provider">) => observation.provider ?? "openai";

/**
 * A limit renewed or went back down between two readings. `scheduled` means
 * it follows the earlier reading's schedule, including skipped windows;
 * `unscheduled` means the provider or operator reset it outside that schedule.
 */
export type LimitReset = { at: number; kind: "scheduled" | "unscheduled"; after: number; before: number };

export type LimitSeries = {
  key: string;
  name: string;
  limitId?: string;
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
  /** Ledger provider (`openai`, `anthropic`, `xai`). */
  provider: string;
  /** The provider's opaque account key; absent when the provider reports none. */
  accountKey?: string;
  planType?: string;
  owners: string[];
  ownerKeys: string[];
  observedAt: number;
  observedBy: string;
  series: LimitSeries[];
  credits?: { hasCredits?: boolean; unlimited?: boolean };
};

/** Percent drops smaller than this are rounding noise, not a reset. */
const RESET_DROP_PERCENT = 1;
export const limitUsageDropped = (before: number, after: number): boolean => after < before - RESET_DROP_PERCENT;
const HOUR = 3_600_000;
/** A pace over less than this is too noisy to project from. */
const MIN_PACE_SPAN = 30 * 60_000;
/** Longer (e.g. weekly) windows need at least an hour of elapsed time. */
const MIN_LONG_WINDOW_PACE_SPAN = HOUR;
/** Sub-percent usage is too small to extrapolate across a full window. */
const MIN_PACE_USAGE_PERCENT = 1;
/** Minor provider clock/rounding drift that still matches the same renewal schedule. */
const SCHEDULE_JITTER_MS = 10 * 60_000;
/** Default same-window resetAt tolerance for providers with exact deadlines. */
const DEFAULT_WINDOW_TOLERANCE_MS = 15 * 60_000;
/** Claude stream events round resetAt up to the next hour. */
const ANTHROPIC_WINDOW_TOLERANCE_MS = 2 * HOUR;
/** Reaching 100% within a minute of reset is effectively full at the reset, not early. */
const MIN_SHORT_LEAD_MS = 60_000;

/**
 * How far two readings' `resetAt` values may differ and still belong to the
 * same window. Claude's stream events round `resetAt` up to the next hour;
 * other providers report exact deadlines modulo minor server/clock drift.
 */
function resetWindowToleranceMs(provider: string, windowMinutes: number | undefined): number {
  const base = provider === "anthropic" ? ANTHROPIC_WINDOW_TOLERANCE_MS : DEFAULT_WINDOW_TOLERANCE_MS;
  if (windowMinutes === undefined) return base;
  return Math.max(SCHEDULE_JITTER_MS, Math.min(base, (windowMinutes * 60_000) / 3));
}

function minPaceSpan(windowMinutes: number | undefined): number {
  if (windowMinutes === undefined) return MIN_PACE_SPAN;
  return Math.max(MIN_PACE_SPAN, Math.min(MIN_LONG_WINDOW_PACE_SPAN, (windowMinutes * 60_000) / 10));
}

/**
 * Deterministic total order for two observations of the same series stamped
 * with the same `observedAt` (e.g. two federated owners relaying at once):
 * prefer the later window, then the higher usage within the same window.
 */
function preferSimultaneousPoint(current: LimitPoint, candidate: LimitPoint, toleranceMs: number): boolean {
  if (current.resetAt !== undefined && candidate.resetAt !== undefined) {
    if (candidate.resetAt > current.resetAt + toleranceMs) return true;
    if (current.resetAt > candidate.resetAt + toleranceMs) return false;
  } else if (candidate.resetAt !== undefined) {
    return true;
  } else if (current.resetAt !== undefined) {
    return false;
  }
  if (candidate.usedPercent !== current.usedPercent) return candidate.usedPercent > current.usedPercent;
  const candidateHasCounts = candidate.used !== undefined && candidate.limit !== undefined;
  const currentHasCounts = current.used !== undefined && current.limit !== undefined;
  if (candidateHasCounts !== currentHasCounts) return candidateHasCounts;
  return (candidate.resetAt ?? 0) > (current.resetAt ?? 0);
}

function isScheduledReset(
  previousResetAt: number | undefined,
  resetAt: number,
  windowMs: number | undefined,
): boolean {
  if (previousResetAt === undefined) return false;
  const delta = resetAt - previousResetAt;
  if (delta < -SCHEDULE_JITTER_MS) return false;
  if (windowMs === undefined) return Math.abs(delta) <= SCHEDULE_JITTER_MS;
  const periods = Math.max(0, Math.round(delta / windowMs));
  return Math.abs(delta - periods * windowMs) <= SCHEDULE_JITTER_MS;
}

const seriesKey = (limit: UsageLimitReading) =>
  JSON.stringify([limit.windowKey ?? "", limit.limitId ?? "", limit.windowKey ? "" : limit.name]);

/**
 * Each account's series by key, built on first lookup. Every limit row looks
 * its series up, and the pace read filters series by the current limits, so
 * a scan per lookup made one render quadratic in the account's limits. An
 * account's `series` array is never mutated after it is built.
 */
const seriesByKey = new WeakMap<readonly LimitSeries[], ReadonlyMap<string, LimitSeries>>();

/** The recorded series for one current limit reading, if the account has one. */
export function limitSeriesFor(account: LimitAccount | undefined, limit: UsageLimitReading): LimitSeries | undefined {
  if (!account) return undefined;
  let index = seriesByKey.get(account.series);
  if (!index) {
    const built = new Map<string, LimitSeries>();
    // The first series with a key wins, as a scan would find it.
    for (const series of account.series) if (!built.has(series.key)) built.set(series.key, series);
    seriesByKey.set(account.series, index = built);
  }
  return index.get(seriesKey(limit));
}

/**
 * Group owners' readings by provider and account, never blending two
 * accounts. Readings without an account key stay with their own owner.
 */
export function buildLimitAccounts(sources: LimitSource[]): LimitAccount[] {
  const accounts = new Map<string, { provider: string; accountKey?: string; planType?: string; owners: Map<string, string>;
    observations: Array<UsageLimitObservation & { owner: string }> }>();
  for (const source of sources) {
    const ownerKey = federationTargetKey(source.target);
    const current = source.current === undefined ? [] : Array.isArray(source.current) ? source.current : [source.current];
    for (const observation of [...source.history ?? [], ...current]) {
      const provider = limitProvider(observation);
      // OpenAI keeps the keys it had before other providers reported limits.
      const scope = provider === "openai" ? "" : `${provider}:`;
      const key = observation.accountKey ? `account:${scope}${observation.accountKey}` : `owner:${scope}${ownerKey}`;
      let account = accounts.get(key);
      if (!account) accounts.set(key, account = { provider, accountKey: observation.accountKey, owners: new Map(), observations: [] });
      account.owners.set(ownerKey, source.owner);
      account.planType ??= observation.planType;
      account.observations.push({ ...observation, owner: source.owner });
    }
  }
  return [...accounts.entries()].map(([key, account]) => {
    const observations = account.observations.sort((a, b) => a.observedAt - b.observedAt);
    const newest = observations.at(-1)!;
    const byLimit = new Map<string, { reading: UsageLimitReading; points: LimitPoint[]; maxResetAt?: number }>();
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
        const toleranceMs = resetWindowToleranceMs(account.provider, limit.windowMinutes ?? entry.reading.windowMinutes);
        const point: LimitPoint = {
          at: observation.observedAt, usedPercent: limit.usedPercent, used: limit.used, limit: limit.limit,
          resetAt: limit.resetAt, ...limit.expires ? { expires: true } : {},
        };
        // Ignore stale relays from a window already superseded by a later resetAt.
        if (point.resetAt !== undefined && entry.maxResetAt !== undefined
          && point.resetAt < entry.maxResetAt - toleranceMs) {
          continue;
        }
        const last = entry.points.at(-1);
        // Several owners can relay the same account reading at the same timestamp.
        if (last && last.at === point.at) {
          if (preferSimultaneousPoint(last, point, toleranceMs)) {
            entry.points[entry.points.length - 1] = point;
            entry.reading = limit;
          }
        } else {
          entry.points.push(point);
          entry.reading = limit;
        }
        const accepted = entry.points.at(-1)!;
        if (accepted.resetAt !== undefined
          && (entry.maxResetAt === undefined || accepted.resetAt > entry.maxResetAt)) {
          entry.maxResetAt = accepted.resetAt;
        }
      }
    }
    const series = [...byLimit.entries()].map(([id, { reading, points }]) => describeSeries(account.provider, id, reading, points))
      .sort(compareSeriesOrder);
    return { key, provider: account.provider, accountKey: account.accountKey, planType: account.planType,
      owners: [...new Set(account.owners.values())], ownerKeys: [...account.owners.keys()], observedAt: newest.observedAt,
      observedBy: newest.owner, series, credits };
  }).sort((a, b) => b.observedAt - a.observedAt);
}

function compareSeriesOrder(left: LimitSeries, right: LimitSeries): number {
  const leftRank = seriesOrderRank(left);
  const rightRank = seriesOrderRank(right);
  if (leftRank.tier !== rightRank.tier) return leftRank.tier - rightRank.tier;
  if (leftRank.pool !== rightRank.pool) return leftRank.pool.localeCompare(rightRank.pool);
  return leftRank.window - rightRank.window;
}

function seriesOrderRank(series: LimitSeries): { tier: number; pool: string; window: number } {
  if (series.windowKey) {
    const window = series.windowKey === "primary" ? 0 : series.windowKey === "secondary" ? 1 : series.windowKey === "individual" ? 2 : 3;
    return { tier: 0, pool: "", window };
  }
  if (series.limitId === "five_hour") return { tier: 0, pool: "", window: 0 };
  if (series.limitId === CLAUDE_WEEKLY_LIMIT_ID) return { tier: 1, pool: "", window: 0 };
  // Keep pool-scoped limits (e.g. Antigravity's Gemini and Claude/GPT pools)
  // paired by pool with 5h ahead of Weekly inside each pool.
  const pooled = /^(5h|weekly)\s+(.+?)\s+limit$/i.exec(series.name.trim());
  if (pooled) {
    const pool = pooled[2]!.toLowerCase();
    return {
      tier: pool === "gemini" ? 2 : 3,
      pool,
      window: pooled[1]!.toLowerCase() === "5h" ? 0 : 1,
    };
  }
  if (series.windowMinutes === 300) return { tier: 0, pool: "", window: 0 };
  if (series.windowMinutes === 10_080) return { tier: 3, pool: "", window: 1 };
  return { tier: 4, pool: "", window: 0 };
}

/** Claude's weekly limit across all models; the others are per model. */
const CLAUDE_WEEKLY_LIMIT_ID = "seven_day";

type ResetDetail = LimitReset & {
  /** Whether usage is known to have restarted from 0% at `at`. */
  zeroAtStart: boolean;
  /** Whether this reset happened inside the same window (e.g. a mid-window credit). */
  sameWindow: boolean;
  /** First post-reset usage observed at `before`, used as baseline when `!zeroAtStart`. */
  observedUsedPercent: number;
};

function describeSeries(provider: string, key: string, reading: UsageLimitReading, points: LimitPoint[]): LimitSeries {
  const windowMs = reading.windowMinutes ? reading.windowMinutes * 60_000 : undefined;
  const windowToleranceMs = resetWindowToleranceMs(provider, reading.windowMinutes);
  const resetDetails: ResetDetail[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const before = points[index - 1];
    const after = points[index];
    const dropped = limitUsageDropped(before.usedPercent, after.usedPercent);
    const elapsed = before.resetAt !== undefined && before.resetAt <= after.at;
    const deadlineAdvanced = before.resetAt !== undefined && after.resetAt !== undefined
      && after.resetAt > before.resetAt + windowToleranceMs;
    // A window whose deadline advanced still reset even if usage was low before
    // the reset or filled back up past its old level.
    if (!dropped && !deadlineAdvanced) {
      continue;
    }
    // A moved schedule says when the new window began, even if the old
    // deadline has now passed. That obsolete deadline can fall inside the
    // current window; treating it as the reset would charge all current usage
    // to the time since that deadline instead of the whole current window.
    const movedSchedule = after.resetAt !== undefined && windowMs !== undefined
      && (before.resetAt === undefined || deadlineAdvanced);
    const began = movedSchedule ? after.resetAt! - windowMs! : undefined;
    const beganInGap = began !== undefined && began > before.at && began <= after.at;
    const beganFuture = began !== undefined && began > after.at;
    const elapsedIntoNewWindow = elapsed && (after.resetAt === undefined || deadlineAdvanced);
    const at = beganInGap ? began
      : elapsedIntoNewWindow && !beganFuture ? before.resetAt! : after.at;
    const zeroAtStart = beganInGap || (elapsedIntoNewWindow && !beganFuture);
    const sameWindow = !movedSchedule && !elapsedIntoNewWindow;
    // A gap can skip full windows without changing the provider's schedule;
    // drops within the same window are always unscheduled.
    const scheduled = !sameWindow && isScheduledReset(before.resetAt, at, windowMs);
    resetDetails.push({
      at,
      kind: scheduled ? "scheduled" : "unscheduled",
      after: before.at,
      before: after.at,
      zeroAtStart,
      sameWindow,
      observedUsedPercent: after.usedPercent,
    });
  }
  const resets: LimitReset[] = resetDetails.map(({ at, kind, after, before }) => ({ at, kind, after, before }));
  const latest = points.at(-1)!;
  const lastReset = resetDetails.at(-1);
  // The provider's schedule says when this window began; a later reset we saw
  // happen wins, since usage restarts at any reset. A mid-window reset/credit
  // inside the same window always overrides `scheduledStart`, even if a coarse
  // reading later rounds `resetAt` up (shifting `scheduledStart` forward).
  // If clock skew places `scheduledStart` ahead of `latest.at`, clamp to
  // `latest.at` so we never fall back to an older reset or pre-window readings.
  const rawScheduledStart = latest.resetAt !== undefined && windowMs !== undefined
    ? latest.resetAt - windowMs : undefined;
  const scheduledStart = rawScheduledStart !== undefined ? Math.min(rawScheduledStart, latest.at) : undefined;
  const resetStart = lastReset && lastReset.at <= latest.at ? lastReset.at : undefined;
  let windowStart: number | undefined;
  let baselineUsed = 0;
  if (lastReset?.sameWindow && resetStart !== undefined) {
    windowStart = resetStart;
    baselineUsed = lastReset.zeroAtStart ? 0 : lastReset.observedUsedPercent;
  } else if (scheduledStart !== undefined && (resetStart === undefined || scheduledStart > resetStart)) {
    windowStart = scheduledStart;
    baselineUsed = 0;
  } else if (resetStart !== undefined) {
    windowStart = resetStart;
    baselineUsed = lastReset!.zeroAtStart ? 0 : lastReset!.observedUsedPercent;
  }
  const minSpan = minPaceSpan(reading.windowMinutes);
  let pacePerHour: number | undefined;
  if (windowStart !== undefined) {
    const span = latest.at - windowStart;
    const deltaUsed = Math.max(0, latest.usedPercent - baselineUsed);
    if (span >= minSpan && deltaUsed >= MIN_PACE_USAGE_PERCENT) {
      pacePerHour = deltaUsed / (span / HOUR);
    }
  } else {
    // No known start (no window length and no observed reset): fall back to
    // the slope across this window's readings.
    const first = points[0];
    if (first) {
      const span = latest.at - first.at;
      const deltaUsed = Math.max(0, latest.usedPercent - first.usedPercent);
      if (span >= minSpan && deltaUsed >= MIN_PACE_USAGE_PERCENT) {
        pacePerHour = deltaUsed / (span / HOUR);
      }
    }
  }
  return { key, name: reading.name, limitId: reading.limitId, windowKey: reading.windowKey, windowMinutes: reading.windowMinutes,
    points, resets,
    latest, windowStart, pacePerHour };
}

/** Each account's "since reset" series, chosen once: every limit row asks. */
const sinceResetByAccount = new WeakMap<readonly LimitSeries[], { series: LimitSeries | undefined }>();

/** The limit a "since reset" window follows: the longest one the account has. */
export function sinceResetSeries(account: LimitAccount | undefined): LimitSeries | undefined {
  if (!account) return undefined;
  let chosen = sinceResetByAccount.get(account.series);
  if (!chosen) sinceResetByAccount.set(account.series, chosen = { series: chooseSinceResetSeries(account) });
  return chosen.series;
}

function chooseSinceResetSeries(account: LimitAccount): LimitSeries | undefined {
  return account.series.find((series) => series.windowKey === "individual")
    ?? account.series.find((series) => series.windowKey === "secondary")
    ?? account.series.find((series) => series.limitId === CLAUDE_WEEKLY_LIMIT_ID)
    ?? account.series.find((series) => !series.windowKey && series.windowMinutes === 10_080)
    ?? account.series.at(-1);
}

/**
 * The account's 5-hour limit. Codex names its windows by position, not
 * length: an account with only a weekly limit reports it as `primary`, so a
 * primary window of another stated length is not the 5-hour limit.
 *
 * When a provider reports multiple 5-hour pools (Antigravity's Gemini and
 * Claude/GPT pools), prefer a pool with a live `resetAt` over an idle pool
 * whose reset was omitted (even if the idle pool has a historical reset's
 * `windowStart`), breaking ties by higher usage and then existing order.
 */
export function fiveHourSeries(account: LimitAccount | undefined): LimitSeries | undefined {
  const candidates = account?.series.filter((series) => series.windowMinutes === 300) ?? [];
  if (candidates.length > 0) {
    return candidates.reduce((best, candidate) => (
      isBetterFiveHourSeries(candidate, best) ? candidate : best
    ));
  }
  return account?.series.find((series) => series.windowKey === "primary" && series.windowMinutes === undefined);
}

function isBetterFiveHourSeries(candidate: LimitSeries, current: LimitSeries): boolean {
  const candidateHasReset = candidate.latest.resetAt !== undefined;
  const currentHasReset = current.latest.resetAt !== undefined;
  if (candidateHasReset !== currentHasReset) return candidateHasReset;
  return candidate.latest.usedPercent > current.latest.usedPercent;
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
  if (!pace || !Number.isFinite(pace) || pace <= 0) return undefined;
  const { latest } = series;
  if (latest.usedPercent >= 100) return undefined;
  if (latest.resetAt !== undefined && latest.resetAt <= latest.at) return undefined;
  const fullAt = latest.at + (100 - latest.usedPercent) / pace * HOUR;
  if (latest.resetAt !== undefined && fullAt > latest.resetAt - MIN_SHORT_LEAD_MS) {
    const projected = latest.usedPercent + pace * (latest.resetAt - latest.at) / HOUR;
    return { kind: "atReset", percent: Math.min(100, Math.max(latest.usedPercent, projected)), resetAt: latest.resetAt };
  }
  return { kind: "full", at: fullAt };
}

export function limitLabel(series: LimitSeries): string {
  if (series.windowMinutes === 300) {
    return series.windowKey || series.limitId === "five_hour" ? "5-hour window" : series.name;
  }
  // Claude and Antigravity have several weekly limits and name each.
  if (series.windowMinutes === 10_080) return series.windowKey ? "Weekly limit" : series.name;
  if (series.windowKey === "individual") return "Individual limit";
  return series.name;
}
