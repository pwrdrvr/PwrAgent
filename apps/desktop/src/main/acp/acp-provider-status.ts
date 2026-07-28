import type {
  BackendAccountSummary,
  BackendRateLimitSummary,
} from "@pwragent/shared";

export type AcpProviderStatus = {
  account?: BackendAccountSummary;
  rateLimits?: BackendRateLimitSummary[];
};

/**
 * Normalize Grok's `x.ai/billing` ACP extension into the same provider
 * metadata contract used by Codex. Newer Grok builds report a percentage and
 * typed current period; older builds used dollar-cent limit/usage fields.
 */
export function normalizeGrokBillingStatus(
  value: unknown,
): AcpProviderStatus | undefined {
  const root = unwrapResult(asRecord(value));
  if (!root) {
    return undefined;
  }
  const config = asRecord(root.config);
  const subscriptionTier =
    readString(root, "subscription_tier")
    ?? readString(root, "subscriptionTier");
  const account: BackendAccountSummary = {
    type: "provider",
    label: "Grok account",
    ...(subscriptionTier ? { planType: subscriptionTier } : {}),
  };
  if (!config) {
    return subscriptionTier ? { account } : undefined;
  }

  const currentPeriod = asRecord(config.currentPeriod);
  const rawUsedPercent =
    readFiniteNumber(config, "creditUsagePercent")
    ?? deriveUsedPercent(config);
  const usedPercent =
    rawUsedPercent === undefined
      ? undefined
      : Math.max(0, Math.min(100, rawUsedPercent));
  const resetAt = parseTimestamp(
    readString(currentPeriod, "end")
    ?? readString(config, "billingPeriodEnd"),
  );
  const rateLimits =
    usedPercent === undefined
      ? undefined
      : [
          {
            name: formatPeriodLimitName(readString(currentPeriod, "type")),
            usedPercent,
            ...(resetAt !== undefined ? { resetAt } : {}),
          },
        ];

  return {
    account,
    ...(rateLimits ? { rateLimits } : {}),
  };
}

function unwrapResult(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return asRecord(value?.result) ?? value;
}

function deriveUsedPercent(
  config: Record<string, unknown>,
): number | undefined {
  const limit = readCentValue(config.monthlyLimit);
  const used = readCentValue(config.used);
  if (limit === undefined || used === undefined || limit <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

function readCentValue(value: unknown): number | undefined {
  return readFiniteNumber(asRecord(value), "val");
}

function formatPeriodLimitName(periodType: string | undefined): string {
  const normalized = periodType?.toLowerCase() ?? "";
  if (normalized.includes("weekly")) {
    return "Weekly limit";
  }
  if (normalized.includes("monthly")) {
    return "Monthly limit";
  }
  return "Included credits";
}

function parseTimestamp(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function readString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
