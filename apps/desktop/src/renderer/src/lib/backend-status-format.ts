import type { BackendSummary } from "@pwragent/shared";

export type BackendRateLimitSummary = NonNullable<BackendSummary["rateLimits"]>[number];

export function formatBackendAccountText(
  account: NonNullable<BackendSummary["account"]>,
): string {
  if (account.type === "chatgpt" && account.email?.trim()) {
    return account.email.trim();
  }
  if (account.type === "apiKey") {
    return "API key";
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
  backend: BackendSummary,
): BackendRateLimitSummary[] {
  return [...(backend.rateLimits ?? [])]
    .filter((limit) => {
      const { label } = splitRateLimitName(limit.name);
      return label === "5h limit" || label === "Weekly limit";
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
  const { label } = splitRateLimitName(limit.name);
  const displayLabel = isSparkRateLimit(limit) ? `Spark ${label}` : label;
  const resetText = formatRateLimitReset(limit.resetAt);
  const suffix = resetText ? `, resets ${resetText}` : "";
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
  return { label: trimmed, labelOrder: 99 };
}

function isSparkRateLimit(limit: BackendRateLimitSummary): boolean {
  return isSparkName(limit.limitId) || isSparkName(limit.name);
}

function isSparkName(value: string | undefined): boolean {
  return value?.toLowerCase().includes("spark") ?? false;
}

function rateLimitFamilyOrder(limit: BackendRateLimitSummary): number {
  return isSparkRateLimit(limit) ? 1 : 0;
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
