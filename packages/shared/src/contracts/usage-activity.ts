import type { FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";
import type { BackendRateLimitSummary } from "./backend";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";

export type ReadUsageActivityRequest = {
  from: number;
  to: number;
  federationTarget?: FederationTarget;
};

/** One account limit as its owner last received it from the provider. */
export type UsageLimitReading = Pick<BackendRateLimitSummary,
  "name" | "limitId" | "windowKey" | "usedPercent" | "used" | "limit" | "resetAt" | "windowMinutes"
  | "hasCredits" | "unlimited">;

/**
 * An owner's account-limit snapshot. Recorded on a turn's ledger row when the
 * turn completes, so a window's readings form an observed history. Limits are
 * account-wide: a reading is never a thread's share of the limit.
 */
export type UsageLimitObservation = {
  /** When the owner last received these limits, not when the turn ended. */
  observedAt: number;
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
export type UsageActivityRollup = { kind: string; count: number };

export type UsageActivityRow = {
  line: ThreadUsageLineRecord;
  title: string;
  updatedAt: number;
  rollup?: UsageActivityRollup;
};

export type ReadUsageActivityResponse = {
  rows: UsageActivityRow[];
  truncated: boolean;
  readAt: number;
  rateLimits: BackendRateLimitSummary[];
  /** The owner's current account limits; absent from older peers. */
  limitObservation?: UsageLimitObservation;
  /**
   * Distinct readings stamped on the window's completed turns, oldest first.
   * A reading can predate its turn's completion; readings are never per-thread.
   */
  limitHistory?: UsageLimitObservation[];
  /**
   * Backends this owner can run usage analysis on. Absent from older peers,
   * which run it on Codex only and ignore `modelBackend`.
   */
  analysisModelBackends?: UsageAnalysisModelBackend[];
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
    });
  }
  return {
    observedAt,
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
