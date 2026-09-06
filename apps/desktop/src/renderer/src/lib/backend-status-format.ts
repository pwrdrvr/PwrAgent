import type { BackendSummary } from "@pwragent/shared";

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
      return left.name.localeCompare(right.name);
    });
}

export function formatRateLimitLine(limit: BackendRateLimitSummary): string {
  if (isCreditsRateLimit(limit)) {
    return formatCreditsLine(limit);
  }
  const { label } = splitRateLimitName(limit.name);
  const displayLabel = isReserveRateLimit(limit)
    ? "Luna Reserve"
    : isSparkRateLimit(limit)
      ? `Spark ${label}`
      : label;
  const resetText = formatRateLimitReset(limit.resetAt);
  const suffix = resetText ? `, resets ${resetText}` : "";
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
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    return { label: "5h limit", labelOrder: 0 };
  }
  if (lower.endsWith("weekly limit")) {
    return { label: "Weekly limit", labelOrder: 1 };
  }
  if (lower.endsWith("individual limit")) {
    return { label: "Individual limit", labelOrder: 2 };
  }
  return { label: trimmed, labelOrder: 99 };
}

function formatWholeNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function isSparkRateLimit(limit: BackendRateLimitSummary): boolean {
  return isSparkName(limit.limitId) || isSparkName(limit.name);
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

function isReserveRateLimit(limit: BackendRateLimitSummary): boolean {
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
