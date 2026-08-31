import { REST, Routes } from "discord.js";
import {
  clipMessagingValidationError,
  type DiscordCredentialValidationConfig,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";
import { validateDiscordSnowflake } from "./validate-ids.ts";

type DiscordCurrentApplication = {
  bot?: {
    discriminator?: string;
    username?: string;
  };
  id: string;
  name?: string;
};

/**
 * Smoke-check the configured Discord bot token by calling the
 * `GET /oauth2/applications/@me` endpoint via the discord.js REST client. This is a
 * stateless REST call — the gateway is NOT connected, no events are
 * subscribed, and no full `Client` is constructed. The REST client
 * does no work until `.get(...)` is called.
 *
 * Contract: see
 * `MessagingCredentialValidationResult` in `@pwragent/messaging-interface`.
 *
 * The desktop main process dispatches here via dynamic import keyed on
 * `channel === "discord"`; the credential never leaves the main
 * process.
 */
export async function validateCredentials(
  config: DiscordCredentialValidationConfig,
): Promise<MessagingCredentialValidationResult> {
  const startedAt = Date.now();
  if (!config.botToken) {
    return {
      status: "unset",
      durationMs: 0,
      testedAt: startedAt,
    };
  }
  try {
    const rest = new REST({ version: "10" }).setToken(config.botToken);
    const application = await readCurrentApplication(rest);
    // discord.js v14: modern users have discriminator "0" (the
    // username#discriminator system was removed in 2023). Render the
    // bare username for those; keep the legacy form for any account
    // still on the old system.
    const account =
      application.bot?.discriminator && application.bot.discriminator !== "0"
        ? `${application.bot.username ?? "unknown"}#${application.bot.discriminator}`
        : (application.bot?.username ?? application.name ?? "unknown");
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account,
      detail: "discord.com/api/v10",
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

export async function discoverDiscordApplicationId(
  config: DiscordCredentialValidationConfig,
): Promise<string> {
  if (!config.botToken) {
    throw new Error("Configure a Discord bot token before discovering its application ID.");
  }
  const rest = new REST({ version: "10" }).setToken(config.botToken);
  return (await readCurrentApplication(rest)).id;
}

async function readCurrentApplication(
  rest: Pick<REST, "get">,
): Promise<DiscordCurrentApplication> {
  const raw = (await rest.get(Routes.oauth2CurrentApplication())) as {
    bot?: {
      discriminator?: unknown;
      username?: unknown;
    };
    id?: unknown;
    name?: unknown;
  };
  const id = typeof raw.id === "string" ? raw.id : "";
  if (!validateDiscordSnowflake(id).ok) {
    throw new Error("Discord returned an invalid current application ID.");
  }
  return {
    id,
    ...(typeof raw.name === "string" ? { name: raw.name } : {}),
    ...(raw.bot
      ? {
          bot: {
            ...(typeof raw.bot.username === "string"
              ? { username: raw.bot.username }
              : {}),
            ...(typeof raw.bot.discriminator === "string"
              ? { discriminator: raw.bot.discriminator }
              : {}),
          },
        }
      : {}),
  };
}
