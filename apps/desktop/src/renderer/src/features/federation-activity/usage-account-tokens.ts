import {
  MAX_ACCOUNT_TOKEN_USAGE_BUCKETS,
  isValidUtcDateString,
  parseAccountTokenUsageObservation,
  type AccountTokenUsageDailyBucket,
  type AccountTokenUsageObservation,
  type AccountTokenUsageSummary,
} from "@pwragent/shared/contracts/usage-activity";
import { federationTargetKey, type FederationTarget } from "@pwragent/shared/contracts/federation";
import type { OwnedUsageRow } from "./usage-activity-summary";

const DAY_MS = 86_400_000;

export type AccountTokenUsageSource = {
  owner: string;
  target: FederationTarget;
  observations?: AccountTokenUsageObservation[];
};

export type AccountTokenAccount = {
  /** Matches `LimitAccount.key`: `account:<key>` or `owner:<ownerKey>` (provider-scoped). */
  key: string;
  provider: string;
  /** Opaque per-account key; absent when the owner did not report one. */
  accountKey?: string;
  planType?: string;
  owners: string[];
  ownerKeys: string[];
  observedAt: number;
  observedBy: string;
  status: AccountTokenUsageObservation["status"];
  /** Reported UTC daily buckets sorted ascending; omitted calendar days stay absent. */
  dailyUsageBuckets: AccountTokenUsageDailyBucket[];
  summary?: AccountTokenUsageSummary;
  firstDate?: string;
  latestDate?: string;
};

export type AccountTokenTrendRange = "14d" | "30d" | "90d" | "all";

export type AccountTokenTrendDay = {
  /** UTC calendar date `YYYY-MM-DD`. */
  date: string;
  /**
   * Provider-reported account-wide tokens across all clients for this UTC day,
   * or `undefined` when the provider omitted this day (never zero-filled).
   */
  accountTokens: number | undefined;
  /**
   * PwrAgent's deduplicated measured tokens for this account on this UTC day
   * (already included in `accountTokens`; never added to it).
   */
  measuredTokens?: number;
  /** Deduplicated PwrAgent contained turns on this UTC day for this account. */
  measuredTurns?: number;
};

export type AccountTokenTrendView = {
  days: AccountTokenTrendDay[];
  reportedDays: number;
  omittedDays: number;
  /** Sum of provider-reported `accountTokens` across reported days in range (never adds ledger rows). */
  rangeTotalTokens: number;
  rangePeakTokens: number;
  /** Sum of deduplicated PwrAgent measured tokens on days in range (subset, never additive). */
  rangeMeasuredTokens: number;
  todayUtc: string;
  includesToday: boolean;
  firstDate?: string;
  latestDate?: string;
};

const RANGE_DAYS: Record<Exclude<AccountTokenTrendRange, "all">, number> = {
  "14d": 14,
  "30d": 30,
  "90d": 90,
};

/** UTC calendar date string `YYYY-MM-DD` for an epoch timestamp. */
export function utcDateString(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

/** Parse a validated `YYYY-MM-DD` date string into UTC midnight epoch ms. */
export function utcDateMs(dateStr: string): number {
  const [year, month, day] = dateStr.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Step a `YYYY-MM-DD` UTC calendar date by `deltaDays` without local DST drift. */
export function addUtcDays(dateStr: string, deltaDays: number): string {
  return utcDateString(utcDateMs(dateStr) + deltaDays * DAY_MS);
}

/** The UsageAccount key matching an account-token series, when account-keyed. */
export function accountTokenUsageAccountKey(
  account: Pick<AccountTokenAccount, "provider" | "accountKey">,
): string | undefined {
  return account.accountKey ? JSON.stringify([account.provider, ["account", account.accountKey]]) : undefined;
}

/**
 * Group and deduplicate provider-reported account-wide token observations across
 * connected owners.
 *
 * Rules:
 * - Observations with the same `(provider, accountKey)` describe ONE account and
 *   are deduplicated (never summed across owners).
 * - Observations without `accountKey` stay isolated to their own `ownerKey`
 *   (never merged across clients even when display labels match).
 * - Omitted daily buckets stay absent (never zero-filled).
 * - Result is deterministic regardless of source arrival order.
 */
export function buildAccountTokenAccounts(sources: AccountTokenUsageSource[]): AccountTokenAccount[] {
  type BucketRecord = {
    provider: string;
    accountKey?: string;
    owners: Map<string, string>;
    observations: Array<AccountTokenUsageObservation & { owner: string; ownerKey: string }>;
  };
  const accounts = new Map<string, BucketRecord>();

  for (const source of sources) {
    const ownerKey = federationTargetKey(source.target);
    for (const rawObservation of source.observations ?? []) {
      const observation = parseAccountTokenUsageObservation(rawObservation);
      if (!observation) continue;
      const provider = observation.provider || "openai";
      const scope = provider === "openai" ? "" : `${provider}:`;
      const key = observation.accountKey
        ? `account:${scope}${observation.accountKey}`
        : `owner:${scope}${ownerKey}`;
      let account = accounts.get(key);
      if (!account) {
        account = {
          provider,
          accountKey: observation.accountKey,
          owners: new Map(),
          observations: [],
        };
        accounts.set(key, account);
      }
      account.owners.set(ownerKey, source.owner);
      account.observations.push({ ...observation, owner: source.owner, ownerKey });
    }
  }

  return [...accounts.entries()].map(([key, account]) => {
    const ordered = [...account.observations].sort(
      (a, b) => a.observedAt - b.observedAt || a.ownerKey.localeCompare(b.ownerKey),
    );
    const available = ordered.filter((item) => item.status === "available");
    const owners = [...new Set(account.owners.values())].sort((a, b) => a.localeCompare(b));
    const ownerKeys = [...account.owners.keys()].sort((a, b) => a.localeCompare(b));

    if (available.length === 0) {
      const latest = ordered.at(-1)!;
      const planType = [...ordered].reverse().find((item) => item.planType)?.planType;
      return {
        key,
        provider: account.provider,
        accountKey: account.accountKey,
        planType,
        owners,
        ownerKeys,
        observedAt: latest.observedAt,
        observedBy: latest.owner,
        status: latest.status,
        dailyUsageBuckets: [],
      };
    }

    const newest = available.at(-1)!;
    const planType = [...available].reverse().find((item) => item.planType)?.planType
      ?? [...ordered].reverse().find((item) => item.planType)?.planType;
    const summary = [...available].reverse().find((item) => item.summary)?.summary;

    // Deduplicate daily buckets across owners sharing this account: never sum.
    // Newer observation wins for each UTC date; equal timestamps take the max
    // so the merge is strictly commutative and independent of arrival order.
    const byDate = new Map<string, { observedAt: number; tokens: number }>();
    for (const observation of available) {
      for (const bucket of observation.dailyUsageBuckets ?? []) {
        if (!isValidUtcDateString(bucket.startDate)
          || typeof bucket.tokens !== "number"
          || !Number.isFinite(bucket.tokens)
          || bucket.tokens < 0) {
          continue;
        }
        const existing = byDate.get(bucket.startDate);
        if (!existing || observation.observedAt > existing.observedAt) {
          byDate.set(bucket.startDate, { observedAt: observation.observedAt, tokens: bucket.tokens });
        } else if (observation.observedAt === existing.observedAt && bucket.tokens > existing.tokens) {
          byDate.set(bucket.startDate, { observedAt: existing.observedAt, tokens: bucket.tokens });
        }
      }
    }

    const dailyUsageBuckets = [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([startDate, entry]) => ({ startDate, tokens: entry.tokens }));

    return {
      key,
      provider: account.provider,
      accountKey: account.accountKey,
      planType,
      owners,
      ownerKeys,
      observedAt: newest.observedAt,
      observedBy: newest.owner,
      status: "available" as const,
      dailyUsageBuckets,
      ...(summary ? { summary } : {}),
      firstDate: dailyUsageBuckets[0]?.startDate,
      latestDate: dailyUsageBuckets.at(-1)?.startDate,
    };
  }).sort((a, b) =>
    Number(b.status === "available") - Number(a.status === "available")
    || b.observedAt - a.observedAt
    || a.key.localeCompare(b.key),
  );
}

/**
 * Project an account's daily UTC token buckets into a calendar-aligned trend
 * view alongside (never summed with) PwrAgent's deduplicated measured rows for
 * the same account.
 */
export function buildAccountTokenTrendView(params: {
  account: AccountTokenAccount;
  range: AccountTokenTrendRange;
  now: number;
  /** Deduplicated contained ledger rows from `summarizeUsageActivity`. */
  measuredRows?: readonly OwnedUsageRow[];
}): AccountTokenTrendView {
  const { account, range, now, measuredRows = [] } = params;
  const todayUtc = utcDateString(now);
  const buckets = account.dailyUsageBuckets;
  if (buckets.length === 0) {
    return {
      days: [],
      reportedDays: 0,
      omittedDays: 0,
      rangeTotalTokens: 0,
      rangePeakTokens: 0,
      rangeMeasuredTokens: 0,
      todayUtc,
      includesToday: false,
      firstDate: undefined,
      latestDate: undefined,
    };
  }

  const bucketMap = new Map(buckets.map((bucket) => [bucket.startDate, bucket.tokens]));
  const firstReported = buckets[0].startDate;
  const latestReported = buckets.at(-1)!.startDate;
  const includesToday = latestReported >= todayUtc;

  // Bucket count is capped but calendar span is not: one ancient date would
  // otherwise chart a bar per day back to it, so "all" is bounded too.
  const spanDays = range === "all" ? MAX_ACCOUNT_TOKEN_USAGE_BUCKETS : RANGE_DAYS[range];
  const earliest = addUtcDays(latestReported, -(spanDays - 1));
  const spanStart = earliest > firstReported ? earliest : firstReported;

  // Aggregate PwrAgent's deduplicated measured turns for THIS account only,
  // bucketed by UTC completion day so the operator can inspect the measured
  // subset next to the provider-reported account total without double-counting.
  const ownerKeySet = new Set(account.ownerKeys);
  const measuredByDate = new Map<string, { tokens: number; turns: number }>();
  for (const row of measuredRows) {
    if (row.line.provider !== account.provider) continue;
    if (row.line.completedAt === undefined) continue;
    const matchesAccount = account.accountKey !== undefined
      ? row.accountKey === account.accountKey
      : row.accountKey === undefined && ownerKeySet.has(federationTargetKey(row.target));
    if (!matchesAccount) continue;
    const day = utcDateString(row.line.completedAt);
    if (day < spanStart || day > latestReported) continue;
    const current = measuredByDate.get(day) ?? { tokens: 0, turns: 0 };
    current.tokens += row.line.totalTokens;
    current.turns += 1;
    measuredByDate.set(day, current);
  }

  const days: AccountTokenTrendDay[] = [];
  let reportedDays = 0;
  let omittedDays = 0;
  let rangeTotalTokens = 0;
  let rangePeakTokens = 0;
  let rangeMeasuredTokens = 0;

  for (let date = spanStart; date <= latestReported; date = addUtcDays(date, 1)) {
    const accountTokens = bucketMap.get(date);
    const measured = measuredByDate.get(date);
    if (accountTokens !== undefined) {
      reportedDays += 1;
      rangeTotalTokens += accountTokens;
      if (accountTokens > rangePeakTokens) rangePeakTokens = accountTokens;
    } else {
      omittedDays += 1;
    }
    if (measured) {
      rangeMeasuredTokens += measured.tokens;
    }
    days.push({
      date,
      accountTokens,
      ...(measured ? { measuredTokens: measured.tokens, measuredTurns: measured.turns } : {}),
    });
  }

  return {
    days,
    reportedDays,
    omittedDays,
    rangeTotalTokens,
    rangePeakTokens,
    rangeMeasuredTokens,
    todayUtc,
    includesToday,
    firstDate: spanStart,
    latestDate: latestReported,
  };
}
