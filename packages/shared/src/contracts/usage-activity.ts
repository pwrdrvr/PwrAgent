import type { FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";
import type { BackendRateLimitSummary } from "./backend";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";

export type ReadUsageActivityRequest = {
  from: number;
  to: number;
  federationTarget?: FederationTarget;
  /**
   * Read provider-reported account-wide daily token history (such as Codex
   * `account/usage/read`) when true. Omitted for sidebar pace probes so
   * refresh stays scoped to the Usage Activity surface. Older peers ignore it.
   */
  includeAccountTokenUsage?: boolean;
};

/** One UTC day reported by a provider's account-wide token history endpoint. */
export type AccountTokenUsageDailyBucket = {
  /** Calendar date in `YYYY-MM-DD` (UTC), as reported by the provider. */
  startDate: string;
  /** Total tokens reported for the account across all clients on this day. */
  tokens: number;
};

/** Provider-reported account-wide summary statistics, when available. */
export type AccountTokenUsageSummary = {
  lifetimeTokens?: number;
  peakDailyTokens?: number;
  longestRunningTurnSec?: number;
  currentStreakDays?: number;
  longestStreakDays?: number;
};

export type AccountTokenUsageUnavailableReason =
  | "unsupported"
  | "auth_required"
  | "unavailable";

/**
 * Provider-reported account-wide daily token history. Never a quota percentage
 * and never additive with PwrAgent's measured per-thread ledger rows. Kept
 * apart from `limitObservations` so older viewers never chart tokens as quota.
 */
export type AccountTokenUsageObservation = {
  /** Ledger provider (`openai`, or another provider with a supported API). */
  provider: string;
  /** Opaque per-account key, matching `UsageLimitObservation.accountKey`. */
  accountKey?: string;
  planType?: string;
  /** When this owner read the provider endpoint. */
  observedAt: number;
  status: "available" | AccountTokenUsageUnavailableReason;
  /** Reported days only; omitted calendar dates stay absent, never zero-filled. */
  dailyUsageBuckets?: AccountTokenUsageDailyBucket[];
  summary?: AccountTokenUsageSummary;
};

/** Opening the Usage Activity window from a provider's surface. */
export type OpenUsageActivityRequest = {
  /** Focus this ledger provider's account limits. */
  provider?: string;
};

/** Providers whose account limits Usage Activity charts. */
export const USAGE_LIMIT_PROVIDERS = ["openai", "anthropic", "xai", "google"] as const;

/** The ledger provider whose account limits a backend's turns count against. */
export function usageLimitProviderForBackend(backend: string | undefined): string | undefined {
  switch (backend) {
    case "codex": return "openai";
    case "claude": return "anthropic";
    case "acp:grok": return "xai";
    case "acp:antigravity": return "google";
    default: return undefined;
  }
}

/** A provider named by an untrusted caller, if it is one Usage Activity knows. */
export function parseUsageLimitProvider(value: unknown): string | undefined {
  return typeof value === "string" && (USAGE_LIMIT_PROVIDERS as readonly string[]).includes(value) ? value : undefined;
}

/** One account limit as its owner last received it from the provider. */
export type UsageLimitReading = Pick<BackendRateLimitSummary,
  "name" | "limitId" | "windowKey" | "usedPercent" | "used" | "limit" | "resetAt" | "windowMinutes"
  | "hasCredits" | "unlimited" | "expires">;

/**
 * An owner's account-limit snapshot. Recorded on a turn's ledger row when the
 * turn completes, so a window's readings form an observed history. Limits are
 * account-wide: a reading is never a thread's share of the limit.
 */
export type UsageLimitObservation = {
  /** When the owner last received these limits, not when the turn ended. */
  observedAt: number;
  /**
   * The ledger provider whose account these limits describe.
   * Absent means OpenAI: older owners reported Codex only.
   */
  provider?: string;
  /** Opaque per-account key, so owners on different accounts never blend. */
  accountKey?: string;
  planType?: string;
  limits: UsageLimitReading[];
};

/**
 * Several background-helper runs (Token Miser, title generation) summed into
 * one line for the thread they worked for. Absent from older peers, which
 * return each run as its own monitor line.
 */
export type UsageActivityRollup = {
  kind: string;
  count: number;
  /** Identity of the unsplit rollup, for mixed-version ledger deduplication. */
  groupKey?: string;
};

export type UsageActivityRow = {
  line: ThreadUsageLineRecord;
  title: string;
  updatedAt: number;
  /**
   * Opaque account key captured for the request and retained in its ledger.
   * Legacy completion readings are a fallback for older rows. Never inferred
   * from the owner's current login. Scoped by `line.provider`.
   */
  accountKey?: string;
  rollup?: UsageActivityRollup;
};

export type ReadUsageActivityResponse = {
  rows: UsageActivityRow[];
  truncated: boolean;
  readAt: number;
  rateLimits: BackendRateLimitSummary[];
  /** The owner's current Codex account limits; absent from older peers. */
  limitObservation?: UsageLimitObservation;
  /**
   * Distinct Codex readings stamped on the window's completed turns, oldest
   * first. A reading can predate its turn's completion; readings are never
   * per-thread.
   */
  limitHistory?: UsageLimitObservation[];
  /**
   * The owner's current limits for every provider that reports them, each
   * with its `provider`. Absent from older peers, which report Codex only in
   * `limitObservation`.
   */
  limitObservations?: UsageLimitObservation[];
  /**
   * Readings from providers other than Codex, as `limitHistory`. Kept apart
   * so a viewer that predates them never charts them as a Codex account.
   */
  providerLimitHistory?: UsageLimitObservation[];
  /**
   * Backends this owner can run usage analysis on. Absent from older peers,
   * which run it on Codex only and ignore `modelBackend`.
   */
  analysisModelBackends?: UsageAnalysisModelBackend[];
  /**
   * Provider-reported account-wide daily token history when requested by
   * Usage Activity (`includeAccountTokenUsage`). Absent from older peers and
   * omitted for non-Usage-Activity probes.
   */
  accountTokenUsage?: AccountTokenUsageObservation[];
};

/**
 * Backends an owner can run usage analysis on. An ACP agent is listed only
 * once it has a tool-less, ephemeral structured helper.
 */
export const USAGE_ANALYSIS_MODEL_BACKENDS = ["codex", "acp:grok"] as const;
export type UsageAnalysisModelBackend = typeof USAGE_ANALYSIS_MODEL_BACKENDS[number];

export type AnalyzeUsageActivityRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  /**
   * Analyze this turn's entries. The owner pages back a bounded number of
   * protocol pages to find it, then falls back to the recent page.
   */
  turnId?: string;
  model: string;
  /**
   * The backend that runs the analysis, which need not be the thread's.
   * Absent means Codex, as for older peers. Send another value only to an
   * owner that lists it in `analysisModelBackends`: an older owner ignores
   * this field and would ask Codex for `model`.
   */
  modelBackend?: UsageAnalysisModelBackend;
  /** Entry and character bounds; the server also enforces these. */
  entryLimit: number;
  characterLimit: number;
  federationTarget?: FederationTarget;
};

export type AnalyzeUsageActivityResponse = {
  analysis: string;
  model: string;
  entries: number;
  characters: number;
  hasEarlierHistory: boolean;
  truncated: boolean;
  /** "turn" when the requested turn was found; absent from older peers. */
  scope?: "turn" | "recent";
  pagesRead?: number;
  /** The backend that ran the analysis; absent from older peers (Codex). */
  modelBackend?: UsageAnalysisModelBackend;
};

const LIMIT_WINDOW_KEYS = new Set(["primary", "secondary", "individual", "credits"]);
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const nonNegativeFinite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const UTC_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Most UTC days an account-token series keeps, and the widest span a viewer charts. */
export const MAX_ACCOUNT_TOKEN_USAGE_BUCKETS = 4_000;

/** Whether `value` is a real calendar date in `YYYY-MM-DD` (UTC). */
export function isValidUtcDateString(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = UTC_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

/**
 * Parse a provider `account/usage/read` response without inventing zero buckets
 * for omitted dates. Returns undefined when the payload carries neither a valid
 * bucket array nor any valid summary statistic.
 */
export function parseAccountTokenUsagePayload(raw: unknown): {
  dailyUsageBuckets: AccountTokenUsageDailyBucket[];
  summary?: AccountTokenUsageSummary;
} | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const root = raw as Record<string, unknown>;
  const hasBucketsArray = Array.isArray(root.dailyUsageBuckets);
  const byDate = new Map<string, number>();
  if (hasBucketsArray) {
    for (const entry of (root.dailyUsageBuckets as unknown[]).slice(0, MAX_ACCOUNT_TOKEN_USAGE_BUCKETS * 2)) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const bucket = entry as Record<string, unknown>;
      const tokens = nonNegativeFinite(bucket.tokens);
      if (!isValidUtcDateString(bucket.startDate) || tokens === undefined) continue;
      const existing = byDate.get(bucket.startDate);
      byDate.set(bucket.startDate, existing === undefined ? tokens : Math.max(existing, tokens));
    }
  }
  const dailyUsageBuckets = [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-MAX_ACCOUNT_TOKEN_USAGE_BUCKETS)
    .map(([startDate, tokens]) => ({ startDate, tokens }));

  const rawSummary = root.summary && typeof root.summary === "object" && !Array.isArray(root.summary)
    ? root.summary as Record<string, unknown>
    : undefined;
  const parsedSummary: AccountTokenUsageSummary = {
    ...(nonNegativeFinite(rawSummary?.lifetimeTokens) !== undefined
      ? { lifetimeTokens: nonNegativeFinite(rawSummary?.lifetimeTokens) } : {}),
    ...(nonNegativeFinite(rawSummary?.peakDailyTokens) !== undefined
      ? { peakDailyTokens: nonNegativeFinite(rawSummary?.peakDailyTokens) } : {}),
    ...(nonNegativeFinite(rawSummary?.longestRunningTurnSec) !== undefined
      ? { longestRunningTurnSec: nonNegativeFinite(rawSummary?.longestRunningTurnSec) } : {}),
    ...(nonNegativeFinite(rawSummary?.currentStreakDays) !== undefined
      ? { currentStreakDays: nonNegativeFinite(rawSummary?.currentStreakDays) } : {}),
    ...(nonNegativeFinite(rawSummary?.longestStreakDays) !== undefined
      ? { longestStreakDays: nonNegativeFinite(rawSummary?.longestStreakDays) } : {}),
  };
  const summary = Object.keys(parsedSummary).length > 0 ? parsedSummary : undefined;

  if (!hasBucketsArray && !summary) return undefined;
  return { dailyUsageBuckets, ...(summary ? { summary } : {}) };
}

const ACCOUNT_TOKEN_USAGE_STATUSES = new Set<AccountTokenUsageObservation["status"]>([
  "available", "unsupported", "auth_required", "unavailable",
]);

/** Parse a relayed account-wide token observation; anything malformed reads as absent. */
export function parseAccountTokenUsageObservation(value: unknown): AccountTokenUsageObservation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const observedAt = finite(source.observedAt);
  const status = typeof source.status === "string" && ACCOUNT_TOKEN_USAGE_STATUSES.has(source.status as AccountTokenUsageObservation["status"])
    ? source.status as AccountTokenUsageObservation["status"]
    : undefined;
  if (observedAt === undefined || !status) return undefined;
  const provider = typeof source.provider === "string" && source.provider.trim()
    ? source.provider.trim().slice(0, 32)
    : "openai";
  const accountKey = typeof source.accountKey === "string" && source.accountKey.trim()
    ? source.accountKey.trim().slice(0, 64)
    : undefined;
  const planType = typeof source.planType === "string" && source.planType.trim()
    ? source.planType.trim().slice(0, 64)
    : undefined;
  if (status !== "available") {
    return {
      provider,
      ...(accountKey ? { accountKey } : {}),
      ...(planType ? { planType } : {}),
      observedAt,
      status,
    };
  }
  const parsed = parseAccountTokenUsagePayload(source);
  if (!parsed) return undefined;
  return {
    provider,
    ...(accountKey ? { accountKey } : {}),
    ...(planType ? { planType } : {}),
    observedAt,
    status: "available",
    dailyUsageBuckets: parsed.dailyUsageBuckets,
    ...(parsed.summary ? { summary: parsed.summary } : {}),
  };
}

/** Parse a stored or relayed reading; anything malformed reads as absent. */
export function parseUsageLimitObservation(value: unknown): UsageLimitObservation | undefined {
  let record: unknown = value;
  if (typeof value === "string") {
    try { record = JSON.parse(value); } catch { return undefined; }
  }
  if (!record || typeof record !== "object") return undefined;
  const source = record as Record<string, unknown>;
  const observedAt = finite(source.observedAt);
  if (observedAt === undefined || !Array.isArray(source.limits)) return undefined;
  const limits: UsageLimitReading[] = [];
  for (const item of source.limits.slice(0, 16)) {
    if (!item || typeof item !== "object") continue;
    const limit = item as Record<string, unknown>;
    if (typeof limit.name !== "string" || !limit.name) continue;
    limits.push({
      name: limit.name.slice(0, 120),
      limitId: typeof limit.limitId === "string" ? limit.limitId.slice(0, 120) : undefined,
      windowKey: typeof limit.windowKey === "string" && LIMIT_WINDOW_KEYS.has(limit.windowKey)
        ? limit.windowKey as UsageLimitReading["windowKey"] : undefined,
      usedPercent: finite(limit.usedPercent),
      used: finite(limit.used),
      limit: finite(limit.limit),
      resetAt: finite(limit.resetAt),
      windowMinutes: finite(limit.windowMinutes),
      hasCredits: typeof limit.hasCredits === "boolean" ? limit.hasCredits : undefined,
      unlimited: typeof limit.unlimited === "boolean" ? limit.unlimited : undefined,
      expires: limit.expires === true ? true : undefined,
    });
  }
  return {
    observedAt,
    provider: typeof source.provider === "string" && source.provider ? source.provider.slice(0, 32) : undefined,
    accountKey: typeof source.accountKey === "string" ? source.accountKey.slice(0, 64) : undefined,
    planType: typeof source.planType === "string" ? source.planType.slice(0, 64) : undefined,
    limits,
  };
}

export function validateUsageActivityWindow(request: ReadUsageActivityRequest): void {
  if (!Number.isFinite(request.from) || !Number.isFinite(request.to)
    || request.from >= request.to || request.to - request.from > 31 * 86_400_000) {
    throw new Error("Select a usage window of at most 31 days.");
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Bar widths a reader can place on a clock, finest first. */
const USAGE_CHART_STEPS = [15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR];
const USAGE_CHART_MAX_BARS = 40;

/**
 * The width of one Usage Activity chart bar for a window: the finest clock
 * step that keeps the window within 40 bars, counting a partial bar at each
 * end. Bars start on local clock boundaries (quarter hours, hours, midnight).
 */
export function usageChartStep(from: number, to: number): number {
  return USAGE_CHART_STEPS.find((step) => Math.ceil((to - from) / step) + 1 <= USAGE_CHART_MAX_BARS)
    ?? USAGE_CHART_STEPS.at(-1)!;
}

/**
 * The step an owner sums background helpers at: the chart's, capped at an
 * hour. Every chart step is a whole number of these, and they sit on epoch
 * boundaries, which are local boundaries in any whole-hour time zone, so a
 * rollup never straddles a bar.
 */
export function usageRollupStep(from: number, to: number): number {
  return Math.min(HOUR, usageChartStep(from, to));
}

/** Never add cumulative snapshots, inherited context, or unattributed history. */
export function usageActivityCoverage(row: UsageActivityRow, from: number, to: number): "contained" | "boundary" | "unattributed" {
  const line = row.line;
  if (line.status === "superseded"
    || (line.scope !== "turn" && line.scope !== "monitor")
    || (line.scope === "turn" && line.turnUsageAttributed !== true)
    || line.turnUsageAttributed === false) return "unattributed";
  const start = line.startedAt ?? line.createdAt;
  return start >= from && start < to && line.completedAt !== undefined
    && line.completedAt >= start && line.completedAt < to ? "contained" : "boundary";
}

/** Shared profiles and relayed peers may expose the same durable ledger row. */
export function usageActivityIdentity(row: UsageActivityRow): string {
  // A helper may be recorded both as a parent's monitor and as the helper
  // thread's own live turn, including on a second instance. Those are two
  // views of the same provider turn, not two charges. Monitor backend labels
  // describe the parent, so use the provider's thread/turn identity here.
  if (row.line.status !== "superseded" && row.line.turnId && (row.line.scope === "monitor"
    || (row.line.scope === "turn" && row.line.turnUsageAttributed === true))) {
    return JSON.stringify([row.line.provider, row.line.threadId, row.line.turnId]);
  }
  return JSON.stringify([row.line.backend, row.line.threadId, row.line.usageLineId]);
}
