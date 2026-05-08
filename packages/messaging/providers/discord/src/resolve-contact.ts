import { REST, Routes } from "discord.js";
import {
  clipMessagingValidationError,
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
        displayName: guild.name ?? guild.id ?? request.id,
        detail: "guild",
      };
    }

    const user = (await rest.get(Routes.user(request.id))) as DiscordLookupUser;
    return {
      status: "ok",
      id: request.id,
      displayName: formatDiscordUserDisplayName(user),
      handle: user.username ? `@${user.username}` : undefined,
      detail: "user",
    };
  } catch (error) {
    return lookupFailure(request.id, error);
  }
}

function formatDiscordUserDisplayName(
  user: DiscordLookupUser,
): string | undefined {
  const username = user.discriminator && user.discriminator !== "0"
    ? `${user.username ?? "unknown"}#${user.discriminator}`
    : user.username;
  const handle = user.username ? `@${user.username}` : undefined;
  const display = user.global_name ?? undefined;
  if (display && handle && display !== user.username) return `${display} (${handle})`;
  return display ?? username ?? handle;
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
