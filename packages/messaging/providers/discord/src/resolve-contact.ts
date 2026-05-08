import { REST, Routes } from "discord.js";
import {
  clipMessagingValidationError,
  sanitizeMessagingContactHandle,
  sanitizeMessagingContactLabel,
  type MessagingContactLookupRequest,
  type MessagingContactLookupResult,
} from "@pwragent/messaging-interface";
import type { DiscordMessagingConfig } from "./discord-config.ts";

type DiscordLookupUser = {
  discriminator?: string;
  global_name?: string | null;
  id?: string;
  username?: string;
};

type DiscordLookupGuild = {
  id?: string;
  name?: string;
};

export async function resolveContact(
  config: Pick<DiscordMessagingConfig, "botToken">,
  request: MessagingContactLookupRequest,
): Promise<MessagingContactLookupResult> {
  if (!config.botToken) {
    return { status: "unset", id: request.id };
  }
  if (request.kind !== "user" && request.kind !== "guild") {
    return {
      status: "unsupported",
      id: request.id,
      errorMessage: `Discord cannot resolve ${request.kind} contacts.`,
    };
  }

  try {
    const rest = new REST({ version: "10" }).setToken(config.botToken);
    if (request.kind === "guild") {
      const guild = (await rest.get(Routes.guild(request.id))) as DiscordLookupGuild;
      return {
        status: "ok",
        id: request.id,
        displayName: sanitizeOptionalContactLabel(guild.name)
          ?? sanitizeOptionalContactLabel(guild.id)
          ?? request.id,
        detail: "guild",
      };
    }

    const user = (await rest.get(Routes.user(request.id))) as DiscordLookupUser;
    const handle = formatContactHandle(user.username);
    return {
      status: "ok",
      id: request.id,
      displayName: formatDiscordUserDisplayName(user),
      handle,
      detail: "user",
    };
  } catch (error) {
    return lookupFailure(request.id, error);
  }
}

function formatDiscordUserDisplayName(
  user: DiscordLookupUser,
): string | undefined {
  const username = sanitizeOptionalContactLabel(user.username);
  const discriminator = sanitizeOptionalContactLabel(user.discriminator);
  const legacyUsername = discriminator && discriminator !== "0"
    ? sanitizeOptionalContactLabel(`${username ?? "unknown"} ${discriminator}`)
    : username;
  const handle = formatContactHandle(user.username);
  const display = sanitizeOptionalContactLabel(user.global_name ?? undefined);
  if (display && handle && display !== username) return `${display} (${handle})`;
  return display ?? legacyUsername ?? handle;
}

function sanitizeOptionalContactLabel(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactLabel(value);
  return sanitized || undefined;
}

function formatContactHandle(value: string | undefined): string | undefined {
  const sanitized = sanitizeMessagingContactHandle(value);
  return sanitized ? `@${sanitized}` : undefined;
}

function lookupFailure(id: string, error: unknown): MessagingContactLookupResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\b(403|404|10013|10004)\b|unknown user|unknown guild|missing access/i.test(message)
    ? "not_found"
    : "failed";
  return {
    status,
    id,
    errorMessage: clipMessagingValidationError(message),
  };
}
