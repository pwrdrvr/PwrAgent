import { createHash } from "node:crypto";

export type TelegramIdentifierField =
  | "callback_query.id"
  | "callback_query.data"
  | "chat.id"
  | "file_id"
  | "message.message_id"
  | "message.message_thread_id"
  | "update.update_id"
  | "user.id";

export type IdentifierValidationReason =
  | "empty"
  | "format"
  | "length"
  | "range"
  | "type";

export type IdentifierValidationResult =
  | { ok: true }
  | { ok: false; reason: IdentifierValidationReason };

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const TELEGRAM_MAX_SAFE_ID = Number.MAX_SAFE_INTEGER;
const TELEGRAM_MAX_SIGNED_ID_LENGTH = 17; // Number.MAX_SAFE_INTEGER is 16 digits plus '-'.
const TELEGRAM_MAX_FILE_ID_LENGTH = 512;
const TELEGRAM_MAX_CALLBACK_QUERY_ID_LENGTH = 128;
const TELEGRAM_CALLBACK_DATA_LIMIT_BYTES = 64;

export function validateTelegramChatId(value: unknown): IdentifierValidationResult {
  return validateTelegramIntegerId(value, { allowNegative: true });
}

export function validateTelegramPositiveId(value: unknown): IdentifierValidationResult {
  return validateTelegramIntegerId(value, { allowNegative: false });
}

export function validateTelegramCallbackQueryId(
  value: unknown,
): IdentifierValidationResult {
  return validateBoundedVisibleAscii(value, TELEGRAM_MAX_CALLBACK_QUERY_ID_LENGTH);
}

export function validateTelegramCallbackData(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Buffer.byteLength(value, "utf8") > TELEGRAM_CALLBACK_DATA_LIMIT_BYTES) {
    return { ok: false, reason: "length" };
  }
  if (!value.startsWith("tg:") || value.length !== 21) {
    return { ok: false, reason: "format" };
  }
  for (let index = 3; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateTelegramFileId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > TELEGRAM_MAX_FILE_ID_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function logTelegramInvalidIdentifier(params: {
  field: TelegramIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "telegram",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
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

function validateBoundedVisibleAscii(
  value: unknown,
  maxLength: number,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > maxLength) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isBase64UrlChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x2d ||
    code === 0x5f
  );
}

function identifierLength(value: unknown): number {
  return typeof value === "string"
    ? value.length
    : typeof value === "number"
      ? String(value).length
      : 0;
}

function identifierHash(value: unknown): string {
  const input =
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
