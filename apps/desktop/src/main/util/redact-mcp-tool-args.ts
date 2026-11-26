import { isSecretFieldName } from "@pwragent/shared/secret-field-names";

const INLINE_SECRET_FLAG_PATTERN =
  /((?:--?)?(?:api[-_]?key|token|secret|password|passphrase|passcode|authorization)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/giu;
const INLINE_ENV_SECRET_PATTERN =
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)[A-Z0-9_]*=)("[^"]*"|'[^']*'|\S+)/gu;
const JSON_SECRET_MEMBER_PATTERN =
  /("[^"]*?(?:api[-_]?key|token|secret|password|passphrase|passcode|authorization|credentials?|private[-_]?key)"\s*:\s*)(?:"(?:[^"\\]|\\.)*"|[^,}\]\s]+)/giu;

const MAX_REDACT_DEPTH = 8;
const DEFAULT_MAX_DETAIL_CHARS = 1_200;

/**
 * Redacts credential-like tokens from a free-text string while preserving
 * line breaks and ordinary spacing.
 */
export function redactSecretStringValue(value: string): string {
  if (/^bearer\s+\S/iu.test(value.trim())) {
    return "[redacted]";
  }
  return value
    .replace(JSON_SECRET_MEMBER_PATTERN, "$1\"[redacted]\"")
    .replace(INLINE_SECRET_FLAG_PATTERN, "$1[redacted]")
    .replace(INLINE_ENV_SECRET_PATTERN, "$1[redacted]");
}

/**
 * Deeply clones a tool-argument payload for display, replacing any field whose
 * name looks like a credential or any bearer/secret string fragment with
 * `"[redacted]"`. Never mutates the original arguments sent to the tool.
 */
export function redactToolArgumentsForDisplay(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") {
    return redactSecretStringValue(value);
  }
  if (value === null || value === undefined || typeof value !== "object") {
    return value;
  }
  if (depth >= MAX_REDACT_DEPTH) {
    return "[truncated]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactToolArgumentsForDisplay(item, depth + 1, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSecretFieldName(key)
      ? "[redacted]"
      : redactToolArgumentsForDisplay(entry, depth + 1, seen);
  }
  return result;
}

/**
 * Formats tool arguments as bounded, secret-redacted pretty JSON for an
 * approval card. Returns `undefined` when the payload is absent or an empty
 * object so zero-arg calls do not show noisy `{}`.
 */
export function formatRedactedToolArguments(
  value: unknown,
  maxChars = DEFAULT_MAX_DETAIL_CHARS,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value as Record<string, unknown>).length === 0) {
    return undefined;
  }
  const redacted = redactToolArgumentsForDisplay(value);
  let formatted: string;
  try {
    formatted = typeof redacted === "string"
      ? redacted
      : JSON.stringify(redacted, null, 2) ?? String(redacted);
  } catch {
    return undefined;
  }
  const trimmed = formatted.trim();
  if (!trimmed || trimmed === "{}") {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}
