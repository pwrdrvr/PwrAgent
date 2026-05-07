import { REST, Routes } from "discord.js";
import {
  clipMessagingValidationError,
  type DiscordCredentialValidationConfig,
  type MessagingCredentialValidationResult,
} from "@pwragent/messaging-interface";

/**
 * Smoke-check the configured Discord bot token by calling the
 * `GET /users/@me` endpoint via the discord.js REST client. This is a
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
    const me = (await rest.get(Routes.user("@me"))) as {
      id?: string;
      username?: string;
      discriminator?: string;
    };
    // discord.js v14: modern users have discriminator "0" (the
    // username#discriminator system was removed in 2023). Render the
    // bare username for those; keep the legacy form for any account
    // still on the old system.
    const account =
      me.discriminator && me.discriminator !== "0"
        ? `${me.username ?? "unknown"}#${me.discriminator}`
        : (me.username ?? "unknown");
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
