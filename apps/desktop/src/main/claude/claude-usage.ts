import type { ModelUsage, SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { BackendRateLimitSummary } from "@pwragent/shared";

export type ClaudeUsageTotals = Record<string, ModelUsage>;

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour limit", seven_day: "Weekly limit",
  seven_day_opus: "Weekly Opus limit", seven_day_sonnet: "Weekly Sonnet limit",
  seven_day_oauth_apps: "Weekly app limit",
};

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
  return Object.entries(usage.rate_limits).flatMap(([name, value]) => {
    if (!value || typeof value !== "object" || !("utilization" in value)
      || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return [];
    const resetAt = "resets_at" in value && typeof value.resets_at === "string" ? Date.parse(value.resets_at) : NaN;
    return [{ name: LIMIT_LABELS[name] ?? name.replaceAll("_", " "), limitId: name,
      usedPercent: value.utilization, ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    }];
  });
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
    return [{ name: LIMIT_LABELS[name] ?? name.replaceAll("_", " "), limitId: name,
      usedPercent: raw.utilization * 100, ...(resetAt !== undefined ? { resetAt } : {}),
    }];
  });
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
