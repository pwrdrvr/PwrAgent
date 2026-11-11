/**
 * Longest cool-off a provider response may impose. A misconfigured proxy or a
 * hostile server could otherwise freeze a delivery scope indefinitely.
 */
export const MESSAGING_RETRY_AFTER_MAX_MS = 60 * 60_000;

/** Case-insensitive header lookup, as on the Fetch API `Headers` object. */
export type MessagingHttpHeaderReader = {
  get(name: string): string | null | undefined;
};

// Longer than any delta-seconds or IMF-fixdate value; bounds parsing cost.
const RETRY_AFTER_VALUE_MAX_LENGTH = 64;
const DELTA_SECONDS_PATTERN = /^\d{1,10}(?:\.\d{1,3})?$/u;

/**
 * Parses an HTTP `Retry-After` value into milliseconds from `nowMs`.
 *
 * RFC 9110 allows either delta-seconds or an HTTP-date. A date in the past
 * means "now" (0 ms). Unparseable values return `undefined` so the caller
 * can fall back to another header or a default.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > RETRY_AFTER_VALUE_MAX_LENGTH) {
    return undefined;
  }
  if (DELTA_SECONDS_PATTERN.test(trimmed)) {
    return Math.min(Math.ceil(Number(trimmed) * 1000), MESSAGING_RETRY_AFTER_MAX_MS);
  }
  // An HTTP-date always names its month. Without this, `Date.parse` reads
  // strings such as "-5" as years.
  if (!/[A-Za-z]/u.test(trimmed)) return undefined;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.min(Math.max(0, dateMs - nowMs), MESSAGING_RETRY_AFTER_MAX_MS);
}

/**
 * Resolves how long to cool off after an HTTP 429.
 *
 * Reads `Retry-After` first, then each provider-documented header in
 * `fallbackSecondsHeaders` (each holding seconds until the limit resets), and
 * finally `defaultMs` when the response names no wait at all.
 */
export function retryAfterMsFromHttpHeaders(params: {
  defaultMs: number;
  fallbackSecondsHeaders?: readonly string[];
  headers?: MessagingHttpHeaderReader;
  nowMs: number;
}): number {
  const { headers, nowMs } = params;
  const fromRetryAfter = parseRetryAfterMs(headers?.get("retry-after"), nowMs);
  if (fromRetryAfter !== undefined) return fromRetryAfter;
  for (const name of params.fallbackSecondsHeaders ?? []) {
    const value = headers?.get(name);
    if (typeof value === "string" && DELTA_SECONDS_PATTERN.test(value.trim())) {
      return Math.min(
        Math.ceil(Number(value.trim()) * 1000),
        MESSAGING_RETRY_AFTER_MAX_MS,
      );
    }
  }
  return Math.min(Math.max(0, params.defaultMs), MESSAGING_RETRY_AFTER_MAX_MS);
}
