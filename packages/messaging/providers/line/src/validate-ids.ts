import { createHash } from "node:crypto";
import type {
  IdentifierValidationReason,
  IdentifierValidationResult,
} from "@pwragent/messaging-interface";

export type LineIdentifierField =
  | "callback.data"
  | "group_id"
  | "message_id"
  | "room_id"
  | "user_id"
  | "webhook_event_id";

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const LINE_ID_LENGTH = 33;
const LINE_MESSAGE_ID_MAX_LENGTH = 32;
const LINE_WEBHOOK_EVENT_ID_MAX_LENGTH = 64;
const LINE_CALLBACK_HANDLE_PREFIX = "line:";
const LINE_CALLBACK_HANDLE_HASH_LENGTH = 18;

export type { IdentifierValidationReason, IdentifierValidationResult };

export function validateLineUserId(value: unknown): IdentifierValidationResult {
  return validateLinePrefixedHexId(value, "U");
}

export function validateLineGroupId(value: unknown): IdentifierValidationResult {
  return validateLinePrefixedHexId(value, "C");
}

export function validateLineRoomId(value: unknown): IdentifierValidationResult {
  return validateLinePrefixedHexId(value, "R");
}

export function validateLineConversationId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.startsWith("U")) return validateLineUserId(value);
  if (value.startsWith("C")) return validateLineGroupId(value);
  if (value.startsWith("R")) return validateLineRoomId(value);
  return { ok: false, reason: value.length === 0 ? "empty" : "format" };
}

export function validateLineMessageId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > LINE_MESSAGE_ID_MAX_LENGTH) return { ok: false, reason: "length" };
  for (let index = 0; index < value.length; index += 1) {
    if (!isAsciiDigit(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateLineWebhookEventId(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > LINE_WEBHOOK_EVENT_ID_MAX_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isBase64UrlChar(code) && code !== 0x3a) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateLineCallbackHandle(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (!value.startsWith(LINE_CALLBACK_HANDLE_PREFIX)) {
    return { ok: false, reason: "format" };
  }
  if (
    value.length !==
      LINE_CALLBACK_HANDLE_PREFIX.length + LINE_CALLBACK_HANDLE_HASH_LENGTH
  ) {
    return { ok: false, reason: "length" };
  }
  for (let index = LINE_CALLBACK_HANDLE_PREFIX.length; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function logLineInvalidIdentifier(params: {
  field: LineIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "line",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
}

function validateLinePrefixedHexId(
  value: unknown,
  prefix: "C" | "R" | "U",
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length !== LINE_ID_LENGTH) return { ok: false, reason: "length" };
  if (value[0] !== prefix) return { ok: false, reason: "format" };
  for (let index = 1; index < value.length; index += 1) {
    if (!isLowercaseHex(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isLowercaseHex(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x61 && code <= 0x66)
  );
}

function isBase64UrlChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x2d
    || code === 0x5f
  );
}

function identifierLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function identifierHash(value: unknown): string {
  const input = typeof value === "string" ? value : "";
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
