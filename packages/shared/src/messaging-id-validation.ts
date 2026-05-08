export type IdentifierValidationReason =
  | "empty"
  | "format"
  | "future"
  | "length"
  | "range"
  | "type";

export type IdentifierValidationResult =
  | { ok: true }
  | { ok: false; reason: IdentifierValidationReason };

const TELEGRAM_MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const TELEGRAM_MAX_SIGNED_ID_LENGTH = 17; // Number.MAX_SAFE_INTEGER is 16 digits plus "-".
const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DISCORD_MAX_SNOWFLAKE_LENGTH = 19;
const DISCORD_MIN_SNOWFLAKE_LENGTH = 17;
const DISCORD_MAX_FUTURE_MS = 24n * 60n * 60n * 1000n;
const MATTERMOST_ID_LENGTH = 26;
const SLACK_MAX_ID_LENGTH = 64;

export function validateTelegramChatId(value: unknown): IdentifierValidationResult {
  return validateTelegramIntegerId(value, { allowNegative: true });
}

export function validateTelegramPositiveId(value: unknown): IdentifierValidationResult {
  return validateTelegramIntegerId(value, { allowNegative: false });
}

export function validateTelegramSupergroupId(
  value: unknown,
): IdentifierValidationResult {
  const result = validateTelegramIntegerId(value, { allowNegative: true });
  if (!result.ok) return result;
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !normalized.startsWith("-100")) {
    return { ok: false, reason: "format" };
  }
  return { ok: true };
}

export function validateDiscordSnowflake(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (
    value.length < DISCORD_MIN_SNOWFLAKE_LENGTH ||
    value.length > DISCORD_MAX_SNOWFLAKE_LENGTH
  ) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    return { ok: false, reason: "range" };
  }
  const timestampMs = (parsed >> 22n) + DISCORD_EPOCH_MS;
  if (timestampMs > BigInt(Date.now()) + DISCORD_MAX_FUTURE_MS) {
    return { ok: false, reason: "future" };
  }
  return { ok: true };
}

export function validateMattermostId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length !== MATTERMOST_ID_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isLowercaseAlphaNumeric(code)) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateSlackUserId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["U", "W"]);
}

export function validateSlackTeamId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["T"]);
}

export function validateSlackChannelId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["C", "G", "D"]);
}

function validateSlackId(
  value: unknown,
  prefixes: readonly string[],
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > SLACK_MAX_ID_LENGTH) {
    return { ok: false, reason: "length" };
  }
  if (!prefixes.includes(value[0] ?? "")) {
    return { ok: false, reason: "format" };
  }
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isAsciiDigit(code) && !isUppercaseAsciiLetter(code)) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

function validateTelegramIntegerId(
  value: unknown,
  options: { allowNegative: boolean },
): IdentifierValidationResult {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      return { ok: false, reason: "type" };
    }
    if (!options.allowNegative && value <= 0) {
      return { ok: false, reason: "range" };
    }
    if (value > TELEGRAM_MAX_SAFE_ID || value < -TELEGRAM_MAX_SAFE_ID) {
      return { ok: false, reason: "range" };
    }
    return { ok: true };
  }

  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > TELEGRAM_MAX_SIGNED_ID_LENGTH) {
    return { ok: false, reason: "length" };
  }

  let start = 0;
  if (value[0] === "-") {
    if (!options.allowNegative || value.length === 1) {
      return { ok: false, reason: "format" };
    }
    start = 1;
  }
  for (let index = start; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return { ok: false, reason: "range" };
  }
  if (!options.allowNegative && parsed <= 0) {
    return { ok: false, reason: "range" };
  }
  return { ok: true };
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isUppercaseAsciiLetter(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isLowercaseAlphaNumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x7a)
  );
}
