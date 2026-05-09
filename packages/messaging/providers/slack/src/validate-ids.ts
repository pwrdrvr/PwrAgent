import { createHash } from "node:crypto";
import type {
  IdentifierValidationReason,
  IdentifierValidationResult,
} from "@pwragent/messaging-interface";

export type SlackIdentifierField =
  | "action_id"
  | "bot_user_id"
  | "callback.value"
  | "channel_id"
  | "file_id"
  | "message_ts"
  | "team_id"
  | "trigger_id"
  | "user_id";

export type IdentifierRejectionLogger = {
  warn?(message: string, data?: Record<string, unknown>): void;
};

const MAX_SLACK_ID_LENGTH = 64;
const MAX_SLACK_TS_LENGTH = 32;
const MAX_SLACK_CALLBACK_HANDLE_LENGTH = 32;

export type { IdentifierValidationReason, IdentifierValidationResult };

export function validateSlackUserId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["U", "W"]);
}

export function validateSlackBotUserId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["U", "W"]);
}

export function validateSlackChannelId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["C", "G", "D"]);
}

export function validateSlackTeamId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["T"]);
}

export function validateSlackFileId(value: unknown): IdentifierValidationResult {
  return validateSlackId(value, ["F"]);
}

export function validateSlackMessageTs(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_SLACK_TS_LENGTH) return { ok: false, reason: "length" };
  let dotSeen = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2e) {
      if (dotSeen || index === 0 || index === value.length - 1) {
        return { ok: false, reason: "format" };
      }
      dotSeen = true;
      continue;
    }
    if (code < 0x30 || code > 0x39) {
      return { ok: false, reason: "format" };
    }
  }
  return dotSeen ? { ok: true } : { ok: false, reason: "format" };
}

export function validateSlackCallbackHandle(
  value: unknown,
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (!value.startsWith("slack:") || value.length > MAX_SLACK_CALLBACK_HANDLE_LENGTH) {
    return { ok: false, reason: "format" };
  }
  for (let index = "slack:".length; index < value.length; index += 1) {
    if (!isBase64UrlChar(value.charCodeAt(index))) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function validateSlackActionId(value: unknown): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > 255) return { ok: false, reason: "length" };
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 0x30 && code <= 0x39)
        || (code >= 0x41 && code <= 0x5a)
        || (code >= 0x61 && code <= 0x7a)
        || code === 0x5f
      )
    ) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
}

export function logSlackInvalidIdentifier(params: {
  field: SlackIdentifierField;
  logger?: IdentifierRejectionLogger;
  reason: IdentifierValidationReason;
  value: unknown;
}): void {
  params.logger?.warn?.("messaging inbound identifier rejected", {
    platform: "slack",
    identifier_field: params.field,
    reason: params.reason,
    length: identifierLength(params.value),
    first8_hash: identifierHash(params.value),
  });
}

function validateSlackId(
  value: unknown,
  prefixes: readonly string[],
): IdentifierValidationResult {
  if (typeof value !== "string") return { ok: false, reason: "type" };
  if (value.length === 0) return { ok: false, reason: "empty" };
  if (value.length > MAX_SLACK_ID_LENGTH) return { ok: false, reason: "length" };
  if (!prefixes.includes(value[0] ?? "")) return { ok: false, reason: "format" };
  for (let index = 1; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      !(
        (code >= 0x30 && code <= 0x39)
        || (code >= 0x41 && code <= 0x5a)
      )
    ) {
      return { ok: false, reason: "format" };
    }
  }
  return { ok: true };
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
