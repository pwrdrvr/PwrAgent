import type { BackendSummary } from "@pwragent/shared/contracts/backend";

export type BackendRateLimitSummary = NonNullable<BackendSummary["rateLimits"]>[number];

export function formatBackendAccountText(
  account: NonNullable<BackendSummary["account"]>,
): string {
  if (account.label?.trim()) {
    return account.label.trim();
  }
  if (account.type === "chatgpt" && account.email?.trim()) {
    return account.email.trim();
  }
  if (account.type === "chatgpt") {
    return "ChatGPT account";
  }
  if (account.type === "apiKey") {
    return "API key";
  }
  if (account.type === "provider") {
    return "Signed in";
  }
  if (account.requiresOpenaiAuth === false) {
    return "Not required";
  }
  if (account.requiresOpenaiAuth === true) {
    return "Not signed in";
  }
  return "Unknown";
}

export function selectVisibleRateLimits(
  backend: Pick<BackendSummary, "kind" | "rateLimits">,
): BackendRateLimitSummary[] {
  const limits = backend.rateLimits ?? [];
  const showLunaReserve = backend.kind === "codex"
    && isPrimaryCodexPlanExhausted(limits);
  return [...limits]
    .filter((limit) => {
      if (backend.kind !== "codex") {
        return true;
      }
      if (isReserveRateLimit(limit)) {
        // Luna Reserve is a post-limit fallback. Hide it until the included
        // Codex 5h or weekly window is exhausted.
        return showLunaReserve;
      }
      if (isCreditsRateLimit(limit)) {
        return isVisibleCreditsLimit(limit);
      }
      const { label } = splitRateLimitName(limit.name);
      return label === "5h limit"
        || label === "Weekly limit"
        || label === "Individual limit";
    })
    .sort((left, right) => {
      const leftName = splitRateLimitName(left.name);
      const rightName = splitRateLimitName(right.name);
      const leftFamilyOrder = rateLimitFamilyOrder(left);
      const rightFamilyOrder = rateLimitFamilyOrder(right);
      if (leftFamilyOrder !== rightFamilyOrder) {
        return leftFamilyOrder - rightFamilyOrder;
      }
      if (leftName.labelOrder !== rightName.labelOrder) {
        return leftName.labelOrder - rightName.labelOrder;
      }
      if (leftName.groupTier !== rightName.groupTier) {
        return leftName.groupTier - rightName.groupTier;
      }
      if (leftName.groupKey !== rightName.groupKey) {
        return leftName.groupKey.localeCompare(rightName.groupKey);
      }
      if (leftName.windowOrder !== rightName.windowOrder) {
        return leftName.windowOrder - rightName.windowOrder;
      }
      return left.name.localeCompare(right.name);
    });
}

/**
 * Codex reports its plan as a lowercase id (`pro`, `business`); an ACP agent
 * reports a display name (`X Premium+`). Capitalize only the ids.
 */
export function formatBackendPlanType(
  backend: Pick<BackendSummary, "kind">,
  planType: string,
): string {
  const trimmed = planType.trim();
  if (backend.kind !== "codex" || !/^[a-z][a-z_-]*$/.test(trimmed)) {
    return trimmed;
  }
  return trimmed
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A percent as every usage surface prints it: one decimal below 10, so a
 * fresh window reads 0.6% rather than 1%, and whole numbers above.
 */
export const formatUsedPercent = (value: number) => `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}`;

/**
 * One limit as a label-column row: a figure the value leads with, the rest of
 * the value, the reset, and the fill for a meter. Reads `% used` like the
 * Usage Activity window, never `% left`.
 */
export type RateLimitRow = {
  label: string;
  figure?: string;
  text?: string;
  reset?: string;
  usedPercent?: number;
};

export function describeRateLimitRow(
  limit: BackendRateLimitSummary,
  now: number,
): RateLimitRow {
  if (isCreditsRateLimit(limit)) {
    if (limit.unlimited) {
      return { label: "Credits", text: "Unlimited" };
    }
    if (typeof limit.remaining === "number" && limit.remaining > 0) {
      return { label: "Credits", figure: formatWholeNumber(limit.remaining) };
    }
    return { label: "Credits", ...(limit.hasCredits ? { text: "Available" } : { figure: "0" }) };
  }
  const resetText = formatRateLimitResetCompact(limit.resetAt, now);
  const base = {
    label: rateLimitDisplayLabel(limit),
    ...(resetText ? { reset: `${limit.expires ? "expires" : "resets"} ${resetText}` } : {}),
  };
  if (typeof limit.used === "number" && typeof limit.limit === "number" && limit.limit > 0) {
    return {
      ...base,
      figure: formatWholeNumber(limit.used),
      text: `of ${formatWholeNumber(limit.limit)} used`,
      usedPercent: typeof limit.usedPercent === "number"
        ? limit.usedPercent
        : (limit.used / limit.limit) * 100,
    };
  }
  if (typeof limit.usedPercent === "number") {
    return { ...base, figure: `${formatUsedPercent(limit.usedPercent)}%`, text: "used", usedPercent: limit.usedPercent };
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number" && limit.limit !== 100 && limit.limit > 0) {
    const used = Math.max(0, limit.limit - limit.remaining);
    return {
      ...base,
      figure: formatWholeNumber(used),
      text: `of ${formatWholeNumber(limit.limit)} used`,
      usedPercent: (used / limit.limit) * 100,
    };
  }
  if (typeof limit.remaining === "number") {
    const used = Math.max(0, Math.min(100, 100 - limit.remaining));
    return { ...base, figure: `${formatUsedPercent(used)}%`, text: "used", usedPercent: used };
  }
  return { ...base, text: "Unavailable" };
}

function rateLimitDisplayLabel(limit: BackendRateLimitSummary): string {
  const { label } = splitRateLimitName(limit.name);
  return isReserveRateLimit(limit)
    ? "Luna Reserve"
    : isSparkRateLimit(limit)
      ? `Spark ${label}`
      : label;
}

export function formatRateLimitLine(limit: BackendRateLimitSummary): string {
  if (isCreditsRateLimit(limit)) {
    return formatCreditsLine(limit);
  }
  const { label } = splitRateLimitName(limit.name);
  const displayLabel = rateLimitDisplayLabel(limit);
  const resetText = formatRateLimitReset(limit.resetAt);
  const suffix = resetText ? `, ${limit.expires ? "expires" : "resets"} ${resetText}` : "";
  if (
    label === "Individual limit"
    && typeof limit.used === "number"
    && typeof limit.limit === "number"
  ) {
    const remainingPercent = typeof limit.usedPercent === "number"
      ? Math.max(0, Math.round(100 - limit.usedPercent))
      : Math.max(0, Math.round(((limit.limit - limit.used) / limit.limit) * 100));
    return `${displayLabel}: ${formatWholeNumber(limit.used)}/${formatWholeNumber(
      limit.limit,
    )} used, ${remainingPercent}% left${suffix}`;
  }
  if (typeof limit.usedPercent === "number") {
    const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
    return `${displayLabel}: ${remaining}% left${suffix}`;
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number") {
    if (limit.limit === 100) {
      return `${displayLabel}: ${Math.max(0, Math.round(limit.remaining))}% left${suffix}`;
    }
    return `${displayLabel}: ${limit.remaining}/${limit.limit} left${suffix}`;
  }
  if (typeof limit.remaining === "number") {
    return `${displayLabel}: ${Math.max(0, Math.round(limit.remaining))}% left${suffix}`;
  }
  return `${displayLabel}: unavailable`;
}

function splitRateLimitName(name: string): {
  label: string;
  labelOrder: number;
  groupTier: number;
  groupKey: string;
  windowOrder: number;
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    return { label: "5h limit", labelOrder: 0, groupTier: 0, groupKey: "", windowOrder: 0 };
  }
  if (lower.endsWith("weekly limit")) {
    return { label: "Weekly limit", labelOrder: 1, groupTier: 0, groupKey: "", windowOrder: 1 };
  }
  if (lower.endsWith("individual limit")) {
    return { label: "Individual limit", labelOrder: 2, groupTier: 0, groupKey: "", windowOrder: 2 };
  }
  // Pool-scoped limits such as "5h Gemini limit" and "Weekly Gemini limit"
  // stay grouped by pool, with 5h ahead of Weekly inside each pool.
  const pooled = /^(5h|weekly)\s+(.+?)\s+limit$/i.exec(trimmed);
  if (pooled) {
    const pool = pooled[2]!.toLowerCase();
    return {
      label: trimmed,
      labelOrder: 99,
      groupTier: pool === "gemini" ? 1 : 2,
      groupKey: pool,
      windowOrder: pooled[1]!.toLowerCase() === "5h" ? 0 : 1,
    };
  }
  return {
    label: trimmed,
    labelOrder: 99,
    groupTier: lower.startsWith("5-hour") ? 0 : 3,
    groupKey: lower,
    windowOrder: 0,
  };
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

export function isSparkRateLimit(limit: BackendRateLimitSummary): boolean {
  return isSparkName(limit.limitId) || isSparkName(limit.name);
}

/** A Codex business account's own cap, which has no window. */
export function isIndividualRateLimit(limit: BackendRateLimitSummary): boolean {
  return splitRateLimitName(limit.name).label === "Individual limit";
}

function isCreditsRateLimit(limit: BackendRateLimitSummary): boolean {
  return limit.windowKey === "credits"
    || limit.limitId?.toLowerCase() === "credits"
    || limit.name === "Credits";
}

function isVisibleCreditsLimit(limit: BackendRateLimitSummary): boolean {
  return limit.unlimited === true || limit.hasCredits === true;
}

function formatCreditsLine(limit: BackendRateLimitSummary): string {
  if (limit.unlimited) {
    return "Credits: unlimited";
  }
  if (typeof limit.remaining === "number" && limit.remaining > 0) {
    return `Credits: ${formatWholeNumber(limit.remaining)}`;
  }
  if (limit.hasCredits) {
    return "Credits: available";
  }
  return "Credits: 0";
}

export function isReserveRateLimit(limit: BackendRateLimitSummary): boolean {
  return limit.limitId?.toLowerCase() === "base_model_inference"
    || limit.limitName?.toLowerCase() === "gpt-reserve"
    || limit.name.toLowerCase().startsWith("gpt-reserve ");
}

function isPrimaryCodexPlanWindow(limit: BackendRateLimitSummary): boolean {
  if (isSparkRateLimit(limit) || isReserveRateLimit(limit)) {
    return false;
  }
  const { label } = splitRateLimitName(limit.name);
  return label === "5h limit" || label === "Weekly limit";
}

function isRateLimitExhausted(limit: BackendRateLimitSummary): boolean {
  if (typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)) {
    return limit.usedPercent >= 100;
  }
  if (typeof limit.remaining === "number" && Number.isFinite(limit.remaining)) {
    return limit.remaining <= 0;
  }
  return false;
}

function isPrimaryCodexPlanExhausted(
  limits: readonly BackendRateLimitSummary[],
): boolean {
  return limits.some(
    (limit) => isPrimaryCodexPlanWindow(limit) && isRateLimitExhausted(limit),
  );
}

function isSparkName(value: string | undefined): boolean {
  return value?.toLowerCase().includes("spark") ?? false;
}

function rateLimitFamilyOrder(limit: BackendRateLimitSummary): number {
  if (isCreditsRateLimit(limit)) {
    return 0;
  }
  if (isReserveRateLimit(limit)) {
    return 2;
  }
  return isSparkRateLimit(limit) ? 3 : 1;
}

function formatRateLimitReset(resetAt: number | undefined): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const now = Date.now();
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (resetAt >= now && resetAt - now < oneDayMs) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Today's time, a weekday and time within the week, else the date. */
function formatRateLimitResetCompact(
  resetAt: number | undefined,
  now: number,
): string | undefined {
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt)) {
    return undefined;
  }
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  if (date.toDateString() === new Date(now).toDateString()) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
  return new Intl.DateTimeFormat(
    undefined,
    resetAt >= now && resetAt - now < sixDaysMs
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric" },
  ).format(date);
}
