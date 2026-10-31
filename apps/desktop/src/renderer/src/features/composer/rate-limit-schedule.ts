import type { BackendRateLimitSummary, BackendModelOption } from "@pwragent/shared";

export const RATE_LIMIT_RESET_BUFFER_MS = 5 * 60_000;
export const RATE_LIMIT_RESET_JITTER_MS = 5 * 60_000;

function shortTermWindowMinutes(limit: BackendRateLimitSummary): number | undefined {
  const minutes = limit.windowMinutes
    ?? (limit.windowSeconds === undefined ? undefined : limit.windowSeconds / 60);
  if (minutes !== undefined) {
    return Number.isFinite(minutes) && minutes > 0 && minutes <= 12 * 60
      ? minutes
      : undefined;
  }
  // Older backends published only a display label, without window metadata.
  const match = /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:h|[- ]?hours?)\s+limit$/i.exec(limit.name)
    ?? /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:h|[- ]?hours?)\s+limit$/i.exec(limit.limitId ?? "");
  const hours = match ? Number(match[1]) : 0;
  return hours > 0 && hours <= 12 ? hours * 60 : undefined;
}

function isAccountRateLimit(limit: BackendRateLimitSummary): boolean {
  if (limit.windowKey === "individual") return false;
  const id = limit.limitId?.trim().toLowerCase();
  if (id) return id === "codex" || id === "five_hour";
  // Primary/secondary are slots within each quota, including Spark's.
  // Only anonymous windows or legacy duration-only labels are generic.
  return !limit.limitName?.trim()
    && (
      limit.windowKey === "primary"
      || limit.windowKey === "secondary"
      || /^\d+(?:\.\d+)?\s*(?:h|[- ]?hours?)\s+limit$/i.test(limit.name)
    );
}

/** Use a future renewing short-term allowance, preferring the selected model. */
export function getShortTermRateLimitResetAt(params: {
  rateLimits?: BackendRateLimitSummary[];
  now: number;
  selectedModelOption?: BackendModelOption;
}): number | undefined {
  const candidates = (params.rateLimits ?? []).filter((limit) =>
    !limit.expires
    && limit.windowKey !== "credits"
    && limit.unlimited !== true
    && typeof limit.resetAt === "number"
    && Number.isFinite(limit.resetAt)
    && limit.resetAt > params.now
    && shortTermWindowMinutes(limit) !== undefined
  );
  const modelTerms = [params.selectedModelOption?.id, params.selectedModelOption?.label]
    .filter((term): term is string => Boolean(term))
    .map((term) => term.toLowerCase());
  const modelSpecific = candidates.filter((limit) =>
    modelTerms.some((term) =>
      [limit.limitId, limit.limitName, limit.name].some((value) => value?.toLowerCase().includes(term))
    )
  );
  const generic = candidates.filter(isAccountRateLimit);
  const preferred = modelSpecific.length > 0 ? modelSpecific : generic;
  return preferred.length > 0 ? Math.min(...preferred.map((limit) => limit.resetAt!)) : undefined;
}

/** Sample once at selection; the existing scheduler persists the resulting timestamp. */
export function getRateLimitResetSendAt(resetAt: number): number {
  return resetAt + RATE_LIMIT_RESET_BUFFER_MS + Math.floor(Math.random() * RATE_LIMIT_RESET_JITTER_MS);
}
