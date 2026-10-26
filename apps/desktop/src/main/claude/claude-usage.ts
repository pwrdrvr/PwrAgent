import type { ModelUsage, SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { BackendRateLimitSummary } from "@pwragent/shared";

export type ClaudeUsageTotals = Record<string, ModelUsage>;

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit", seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit", seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_oauth_apps: "Weekly app limit",
  seven_day_overage_included: "Weekly limit with extra usage",
  overage: "Extra usage",
  // Undocumented. Matched to Claude's "Cloud session credits" by its
  // utilization and expiry; the SDK types and CLI never name it.
  iguana_necktie: "Cloud session credits",
};
/** Window lengths, so a 5-hour or weekly limit can anchor a usage window. */
const LIMIT_WINDOW_MINUTES: Record<string, number> = {
  five_hour: 300, seven_day: 10_080, seven_day_opus: 10_080, seven_day_sonnet: 10_080,
  seven_day_oauth_apps: 10_080, seven_day_overage_included: 10_080,
};
/** Grants that end on their date instead of renewing. */
const EXPIRING_LIMITS = new Set(["iguana_necktie"]);
/** Handled on their own: a per-model array, and a credit balance that is not a limit. */
const NON_WINDOW_KEYS = new Set(["model_scoped", "extra_usage"]);

function limitRow(key: string, usedPercent: number, resetAt: number | undefined): BackendRateLimitSummary {
  const label = LIMIT_LABELS[key];
  return {
    // A key Claude adds later is an internal codename; never show it raw.
    name: label ?? "Other plan limit", limitId: key,
    ...(label ? {} : { limitName: key }),
    usedPercent,
    ...(resetAt !== undefined && Number.isFinite(resetAt) ? { resetAt } : {}),
    ...(LIMIT_WINDOW_MINUTES[key] ? { windowMinutes: LIMIT_WINDOW_MINUTES[key] } : {}),
    ...(EXPIRING_LIMITS.has(key) ? { expires: true } : {}),
  };
}

// Model totals include subagents and compaction. They survive SDK resume;
// subtract our last observation rather than charging the transcript again.
export function claudeTurnUsage(current: ClaudeUsageTotals, previous: ClaudeUsageTotals = {}) {
  const last = { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
  let costUSD = 0;
  const models: string[] = [];
  for (const [model, usage] of Object.entries(current)) {
    const prior = previous[model];
    // /clear resets the running totals. A reset starts a new baseline.
    const reset = prior && (usage.costUSD < prior.costUSD || usage.inputTokens < prior.inputTokens);
    const delta = (key: keyof ModelUsage): number => {
      const value = usage[key];
      const before = reset ? 0 : prior?.[key];
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, value - (typeof before === "number" && Number.isFinite(before) ? before : 0)) : 0;
    };
    const input = delta("inputTokens");
    const cached = delta("cacheReadInputTokens");
    const written = delta("cacheCreationInputTokens");
    const output = delta("outputTokens");
    const cost = delta("costUSD");
    if (input + cached + written + output > 0 || cost > 0) models.push(model);
    last.inputTokens += input + cached + written;
    last.cachedInputTokens += cached;
    last.cacheWriteInputTokens += written;
    last.outputTokens += output;
    last.reasoningOutputTokens += delta("thinkingTokens");
    costUSD += cost;
  }
  last.totalTokens = last.inputTokens + last.outputTokens;
  return { last, claudeCostUSD: costUSD, model: models.join(", ") };
}

export function claudeRateLimits(usage: SDKControlGetUsageResponse): BackendRateLimitSummary[] {
  if (!usage.rate_limits_available || !usage.rate_limits) return [];
  const parseReset = (value: unknown): number | undefined =>
    typeof value === "string" ? Date.parse(value) : undefined;
  const windows = Object.entries(usage.rate_limits).flatMap(([name, value]) => {
    if (NON_WINDOW_KEYS.has(name) || !value || typeof value !== "object" || !("utilization" in value)
      || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return [];
    return [limitRow(name, value.utilization, parseReset("resets_at" in value ? value.resets_at : undefined))];
  });
  // Per-model weekly windows (Fable, ...), labelled by the server.
  const modelScoped = Array.isArray(usage.rate_limits.model_scoped) ? usage.rate_limits.model_scoped : [];
  for (const entry of modelScoped) {
    if (!entry || typeof entry.display_name !== "string" || !entry.display_name.trim()
      || typeof entry.utilization !== "number" || !Number.isFinite(entry.utilization)) continue;
    const resetAt = parseReset(entry.resets_at);
    windows.push({
      name: `Weekly ${entry.display_name.trim()} limit`,
      limitId: `model_scoped:${entry.display_name.trim()}`,
      usedPercent: entry.utilization,
      ...(resetAt !== undefined && Number.isFinite(resetAt) ? { resetAt } : {}),
      windowMinutes: 10_080,
    });
  }
  return windows;
}

/** Stream utilization is a fraction; the control response above uses percent. */
export function claudeStreamRateLimits(info: SDKRateLimitInfo): BackendRateLimitSummary[] {
  // New CLIs also publish all windows in this extension, still absent from
  // SDK 0.3.296's declaration. Validate it rather than assuming it exists.
  // Wire example: anthropics/claude-code#91857.
  const extended = info as SDKRateLimitInfo & { unifiedWindows?: unknown };
  const windows: Record<string, unknown> = extended.unifiedWindows && typeof extended.unifiedWindows === "object"
    ? { ...extended.unifiedWindows } : {};
  if (info.rateLimitType && info.utilization !== undefined) windows[info.rateLimitType] = info;
  return Object.entries(windows).flatMap(([name, raw]) => {
    if (!raw || typeof raw !== "object" || !("utilization" in raw)
      || typeof raw.utilization !== "number" || !Number.isFinite(raw.utilization) || raw.utilization < 0) return [];
    const resetAt = "resetsAt" in raw && typeof raw.resetsAt === "number" && Number.isFinite(raw.resetsAt)
      ? raw.resetsAt * 1000 : undefined;
    return [limitRow(name, raw.utilization * 100, resetAt)];
  });
}

/**
 * A stream reset is rounded up to the hour, so one window's resets can differ
 * by up to an hour. The next window starts at the first use after the reset,
 * at least five hours later, so a larger move is a new window.
 */
const SAME_WINDOW_RESET_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/**
 * Stream windows arrive one or two at a time and are coarser than the usage
 * snapshot (whole percent, reset rounded to the hour). Fill gaps and raise
 * utilization, but never let one replace a finer reading of a live window.
 */
export function mergeClaudeStreamRateLimits(
  current: BackendRateLimitSummary[], update: BackendRateLimitSummary[], now: number,
): BackendRateLimitSummary[] {
  const limits = new Map(current.map((limit) => [limit.limitId, limit]));
  for (const limit of update) {
    const known = limits.get(limit.limitId);
    const live = known?.resetAt !== undefined && known.resetAt > now
      && !(limit.resetAt !== undefined && limit.resetAt > known.resetAt + SAME_WINDOW_RESET_TOLERANCE_MS);
    const usedPercent = known?.usedPercent === undefined || limit.usedPercent === undefined
      ? known?.usedPercent ?? limit.usedPercent
      : Math.max(known.usedPercent, limit.usedPercent);
    limits.set(limit.limitId, live ? { ...known, usedPercent } : limit);
  }
  return [...limits.values()];
}

/** The earliest reset still ahead, when a shown window will stop describing the account. */
export function nextClaudeRateLimitReset(limits: BackendRateLimitSummary[], now: number): number | undefined {
  let next: number | undefined;
  for (const { resetAt } of limits) {
    if (resetAt !== undefined && resetAt > now && (next === undefined || resetAt < next)) next = resetAt;
  }
  return next;
}

/** A window past its reset no longer describes the account; hide it until Claude reports again. */
export function liveClaudeRateLimits(limits: BackendRateLimitSummary[], now: number): BackendRateLimitSummary[] {
  return limits.filter((limit) => limit.resetAt === undefined || limit.resetAt > now);
}

/** Optional control methods must never prevent a turn from completing. */
export async function claudeTelemetry<T>(read: () => Promise<T>): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([read(), new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), 1500);
    })]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}
