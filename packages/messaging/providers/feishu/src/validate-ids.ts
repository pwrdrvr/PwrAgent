import { createHash } from "node:crypto";
import type {
  IdentifierValidationReason,
  IdentifierValidationResult,
} from "@pwragent/messaging-interface";

export type FeishuIdentifierField =
  | "callback.value"
  | "chat_id"
  | "message_id"
  | "open_id"
  | "tenant_key"
  | "union_id"
  | "webhook_event_id";

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const MAX_FEISHU_ID_LENGTH = 128;
const MAX_FEISHU_TENANT_KEY_LENGTH = 64;
const FEISHU_CALLBACK_HANDLE_PREFIX = "feishu:";
const FEISHU_CALLBACK_HANDLE_HASH_LENGTH = 18;

export type { IdentifierValidationReason, IdentifierValidationResult };

export function validateFeishuOpenId(value: unknown): IdentifierValidationResult {
  return validateFeishuPrefixedId(value, "ou_", MAX_FEISHU_ID_LENGTH);
}

export function validateFeishuUnionId(value: unknown): IdentifierValidationResult {
  return validateFeishuPrefixedId(value, "on_", MAX_FEISHU_ID_LENGTH);
}

export function validateFeishuChatId(value: unknown): IdentifierValidationResult {
  return validateFeishuPrefixedId(value, "oc_", MAX_FEISHU_ID_LENGTH);
}

export function validateFeishuMessageId(value: unknown): IdentifierValidationResult {
  return validateFeishuPrefixedId(value, "om_", MAX_FEISHU_ID_LENGTH);
}

export function validateFeishuTenantKey(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_FEISHU_TENANT_KEY_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isTokenChar(code)) return { ok: false, reason: "format" };
  }
  return { ok: true };
}

export function validateFeishuCallbackHandle(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (!value.startsWith(FEISHU_CALLBACK_HANDLE_PREFIX)) {
    return { ok: false, reason: "format" };
  }
  if (
    value.length !==
      FEISHU_CALLBACK_HANDLE_PREFIX.length + FEISHU_CALLBACK_HANDLE_HASH_LENGTH
  ) {
    return { ok: false, reason: "length" };
  }
  for (
    let index = FEISHU_CALLBACK_HANDLE_PREFIX.length;
    index < value.length;
    index += 1
  ) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function logFeishuInvalidIdentifier(params: {
  field: FeishuIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "feishu",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
}

function validateFeishuPrefixedId(
  value: unknown,
  prefix: string,
  maxLength: number,
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > maxLength) return { ok: false, reason: "length" };
  if (!value.startsWith(prefix)) return { ok: false, reason: "format" };
  if (value.length === prefix.length) return { ok: false, reason: "format" };
  for (let index = prefix.length; index < value.length; index += 1) {
    if (!isTokenChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

function isTokenChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39)
    || (code >= 0x41 && code <= 0x5a)
    || (code >= 0x61 && code <= 0x7a)
    || code === 0x5f
    || code === 0x2d
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
