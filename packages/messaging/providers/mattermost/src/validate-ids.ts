import { createHash } from "node:crypto";

export type MattermostIdentifierField =
  | "callback.context.handle"
  | "channel_id"
  | "file_id"
  | "post_id"
  | "response_url"
  | "root_id"
  | "team_id"
  | "token"
  | "trigger_id"
  | "user_id";

export type IdentifierValidationReason =
  | "empty"
  | "format"
  | "length"
  | "type";

export type IdentifierValidationResult =
  | { ok: true }
  | { ok: false; reason: IdentifierValidationReason };

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const MATTERMOST_ID_LENGTH = 26;
const MATTERMOST_MAX_TOKEN_LENGTH = 256;
const MATTERMOST_MAX_RESPONSE_URL_LENGTH = 2048;

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

export function validateMattermostCallbackHandle(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (!value.startsWith("mattermost:") || value.length !== 29) {
    return { ok: false, reason: "format" };
  }
  for (let index = "mattermost:".length; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateMattermostOpaqueToken(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > MATTERMOST_MAX_TOKEN_LENGTH) {
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

export function validateMattermostResponseUrl(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > MATTERMOST_MAX_RESPONSE_URL_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return { ok: false, reason: "format" };
    }
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? { ok: true }
      : { ok: false, reason: "format" };
  } catch {
    return { ok: false, reason: "format" };
  }
}

export function logMattermostInvalidIdentifier(params: {
  field: MattermostIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "mattermost",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
}

function isLowercaseAlphaNumeric(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x7a)
  );
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
  return typeof value === "string" ? value.length : 0;
}

function identifierHash(value: unknown): string {
  const input = typeof value === "string" ? value : "";
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
