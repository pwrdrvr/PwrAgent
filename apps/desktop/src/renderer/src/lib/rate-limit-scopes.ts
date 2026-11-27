import {
  isReserveRateLimit,
  isSparkRateLimit,
  type BackendRateLimitSummary,
} from "./backend-status-format";

/** A limit's renewal window, as a short row label: "Weekly", "5h". */
export type RateLimitWindow = {
  label: string;
  /** Its length, when known: orders a scope's windows, longest first. */
  minutes?: number;
};

export type ScopedRateLimit = {
  limit: BackendRateLimitSummary;
  window: RateLimitWindow;
};

/**
 * One provider's limits on one shared allowance: Antigravity's "Claude/GPT"
 * and "Gemini" pools, or Claude's "Fable". `scope` is null when the provider
 * has a single scope, so a surface names scopes only where there are several.
 * `windows` runs longest first (Weekly, then 5h).
 */
export type RateLimitScopeGroup = {
  scope: string | null;
  windows: ScopedRateLimit[];
};

/** The name of a provider's unscoped limits beside its scoped ones. */
export const UNSCOPED_RATE_LIMIT_LABEL = "All models";

const MINUTES_PER_DAY = 24 * 60;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Window words a limit's name can carry, as the row label shows them. */
const NAMED_WINDOWS: Record<string, RateLimitWindow> = {
  "5h": { label: "5h", minutes: 300 },
  "5-hour": { label: "5h", minutes: 300 },
  daily: { label: "Daily", minutes: MINUTES_PER_DAY },
  weekly: { label: "Weekly", minutes: MINUTES_PER_WEEK },
  monthly: { label: "Monthly" },
};

/**
 * `[scope ]<window>[ scope] limit`: Codex puts a scoped limit's name before
 * the window ("GPT-5.3-Codex-Spark 5h limit"); Claude and Antigravity put it
 * between the window and "limit" ("Weekly Fable limit", "5h Gemini limit").
 */
const LIMIT_NAME = /^(?:(.+?)\s+)?(5h|5-hour|daily|weekly|monthly|\d+[hd])(?:\s+(.+?))?\s+limit$/i;

/** A window length as its row label, from the provider's structured field. */
export function rateLimitWindowFromMinutes(minutes: number): RateLimitWindow | undefined {
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
  if (minutes === MINUTES_PER_WEEK) return { label: "Weekly", minutes };
  if (minutes === MINUTES_PER_DAY) return { label: "Daily", minutes };
  if (minutes % MINUTES_PER_DAY === 0) return { label: `${minutes / MINUTES_PER_DAY}d`, minutes };
  if (minutes % 60 === 0) return { label: `${minutes / 60}h`, minutes };
  return { label: `${Math.round(minutes)}m`, minutes };
}

function windowMinutes(limit: BackendRateLimitSummary): number | undefined {
  if (typeof limit.windowMinutes === "number") return limit.windowMinutes;
  if (typeof limit.windowSeconds === "number") return limit.windowSeconds / 60;
  return undefined;
}

/**
 * A limit's window and scope. The window comes from its structured length
 * when the provider reports one, else from its name; no provider reports a
 * scope field (Antigravity's `limitId` is a per-bucket id), so the scope is
 * always the name's other words. Undefined for a limit with no window: a
 * credit balance, extra usage, an individual cap.
 */
export function rateLimitWindowAndScope(
  limit: BackendRateLimitSummary,
): { window: RateLimitWindow; scope?: string } | undefined {
  const parsed = LIMIT_NAME.exec(limit.name.trim());
  const minutes = windowMinutes(limit);
  const structured = minutes === undefined ? undefined : rateLimitWindowFromMinutes(minutes);
  const named = parsed ? namedWindow(parsed[2]!) : undefined;
  const window = structured ?? named;
  if (!window) return undefined;
  const scope = scopeName(limit) ?? (parsed?.[1] ?? parsed?.[3])?.trim();
  return scope ? { window, scope } : { window };
}

/**
 * Codex's reserve and Spark windows carry model ids in their names
 * ("gpt-reserve", "GPT-5.3-Codex-Spark"); they read as the panel names them.
 */
function scopeName(limit: BackendRateLimitSummary): string | undefined {
  if (isReserveRateLimit(limit)) return "Luna Reserve";
  if (isSparkRateLimit(limit)) return "Spark";
  return undefined;
}

function namedWindow(word: string): RateLimitWindow | undefined {
  const lower = word.toLowerCase();
  const known = NAMED_WINDOWS[lower];
  if (known) return known;
  const amount = Number(lower.slice(0, -1));
  return rateLimitWindowFromMinutes(lower.endsWith("d") ? amount * MINUTES_PER_DAY : amount * 60);
}

/**
 * Splits one provider's rate-limit list by scope. Scopes keep the order of
 * their first limit in `limits`; each scope's windows run longest first.
 * Limits with no window (a credit balance, extra usage, an individual cap)
 * belong to no scope and are left out.
 */
export function groupRateLimitsByScope(limits: readonly BackendRateLimitSummary[]): RateLimitScopeGroup[] {
  const scopes = new Map<string, { scope?: string; windows: ScopedRateLimit[] }>();
  for (const limit of limits) {
    const parsed = rateLimitWindowAndScope(limit);
    if (!parsed) continue;
    const key = parsed.scope?.toLowerCase() ?? "";
    let group = scopes.get(key);
    if (!group) {
      group = parsed.scope ? { scope: parsed.scope, windows: [] } : { windows: [] };
      scopes.set(key, group);
    }
    group.windows.push({ limit, window: parsed.window });
  }
  const single = scopes.size === 1;
  return [...scopes.values()].map((group) => ({
    scope: single ? null : group.scope ?? UNSCOPED_RATE_LIMIT_LABEL,
    // Stable: windows of unknown length keep their place after the known ones.
    windows: group.windows.sort((left, right) => (right.window.minutes ?? -1) - (left.window.minutes ?? -1)),
  }));
}
