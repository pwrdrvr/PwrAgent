/**
 * The Codex App Server reports turn failures via a `TurnError.message` string.
 * For provider-side failures (e.g. an OpenAI Responses 400) that string is not
 * a human sentence — it is the upstream JSON error envelope serialized verbatim,
 * for example:
 *
 *   {"type":"error","error":{"type":"image_generation_user_error",
 *    "code":"invalid_value","message":"The model 'gpt-image-2' does not exist.",
 *    "param":"tools"},"status":400}
 *
 * Surfacing that blob to a user (in the transcript banner or a bound chat) is
 * noise. `parseCodexTurnErrorMessage` extracts the human-readable sentence when
 * the message is a recognizable JSON envelope, and otherwise returns the raw
 * text unchanged. It never throws and always returns a non-empty string.
 */

const FALLBACK_MESSAGE = "Turn failed.";

function tryParseJsonObject(value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Pull the most specific human-readable message out of a parsed error envelope.
 * Handles the common shapes: `{ message }`, `{ error: { message } }`,
 * `{ error: "..." }`, and the nested `{ error: { error: { message } } }`.
 */
function extractEnvelopeMessage(
  record: Record<string, unknown>,
  depth = 0,
): string | undefined {
  if (depth > 4) {
    return undefined;
  }
  const directMessage = nonEmptyString(record.message);
  const nestedError = record.error;
  const nestedRecord = asRecord(nestedError);
  if (nestedRecord) {
    const nestedMessage = extractEnvelopeMessage(nestedRecord, depth + 1);
    if (nestedMessage) {
      return nestedMessage;
    }
  }
  const nestedErrorString = nonEmptyString(nestedError);
  return directMessage ?? nestedErrorString;
}

export function parseCodexTurnErrorMessage(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return FALLBACK_MESSAGE;
  }

  const parsed = tryParseJsonObject(trimmed);
  if (parsed) {
    const message = extractEnvelopeMessage(parsed);
    if (message) {
      return message;
    }
  }

  return trimmed;
}
