import { createHash } from "node:crypto";

export type DiscordIdentifierField =
  | "application_id"
  | "attachment.id"
  | "attachment.url"
  | "channel_id"
  | "custom_id"
  | "guild_id"
  | "interaction.id"
  | "interaction.token"
  | "message.id"
  | "user.id";

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

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const DISCORD_EPOCH_MS = 1_420_070_400_000n;
const DISCORD_MAX_SNOWFLAKE_LENGTH = 19;
const DISCORD_MIN_SNOWFLAKE_LENGTH = 17;
const DISCORD_MAX_FUTURE_MS = 24n * 60n * 60n * 1000n;
const DISCORD_MAX_TOKEN_LENGTH = 256;
const DISCORD_MAX_CUSTOM_ID_BYTES = 100;
const DISCORD_MAX_ATTACHMENT_URL_LENGTH = 2048;
const DISCORD_ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

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

export function validateDiscordInteractionToken(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > DISCORD_MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (!isBase64UrlOrDotChar(code)) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateDiscordCustomId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (Buffer.byteLength(value, "utf8") > DISCORD_MAX_CUSTOM_ID_BYTES) {
    return { ok: false, reason: "length" };
  }
  if (!value.startsWith("dc:") || value.length !== 27) {
    return { ok: false, reason: "format" };
  }
  for (let index = 3; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateDiscordAttachmentUrl(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") {
    return { ok: false, reason: "type" };
  }
  if (value.length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (value.length > DISCORD_MAX_ATTACHMENT_URL_LENGTH) {
    return { ok: false, reason: "length" };
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) {
      return { ok: false, reason: "format" };
    }
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: "format" };
  }
  if (parsed.protocol !== "https:" || !DISCORD_ATTACHMENT_HOSTS.has(parsed.hostname)) {
    return { ok: false, reason: "format" };
  }
  return { ok: true };
}

export function logDiscordInvalidIdentifier(params: {
  field: DiscordIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "discord",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
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

function isBase64UrlOrDotChar(code: number): boolean {
  return isBase64UrlChar(code) || code === 0x2e;
}

function identifierLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function identifierHash(value: unknown): string {
  const input = typeof value === "string" ? value : "";
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}
