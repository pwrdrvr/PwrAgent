import { Bot } from "grammy";
import {
  clipMessagingValidationError,
  type MessagingCredentialValidationResult,
  type TelegramCredentialValidationConfig,
} from "@pwragent/messaging-interface";

/**
 * Smoke-check the configured Telegram bot token by calling the Bot API
 * `getMe` endpoint via grammy. This is a stateless REST call — no
 * polling started, no webhook configured, no adapter state created.
 * Construction of `new Bot(token)` only stores the token; calling
 * `bot.api.getMe()` issues a single HTTPS request.
 *
 * Contract: see
 * `MessagingCredentialValidationResult` in `@pwragent/messaging-interface`.
 *
 * The desktop main process dispatches here via dynamic import keyed on
 * `channel === "telegram"`; the credential never leaves the main
 * process.
 *
 * Token-leak guard: Telegram puts the bot token IN THE URL PATH
 * (`/bot<TOKEN>/getMe`), unlike Discord which uses a header. When
 * grammy's underlying fetch fails with a network-layer error
 * (DNS / TLS / ECONNREFUSED), the error message can include the URL
 * verbatim — token and all. `scrubBotToken` strips any `/bot<token>`
 * fragment from error text BEFORE we hand it to the result so the
 * renderer / log never displays the credential.
 */
export async function validateCredentials(
  config: TelegramCredentialValidationConfig,
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
    const bot = new Bot(config.botToken);
    const me = await bot.api.getMe();
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account: formatAccount(me),
      detail: "api.telegram.org",
    };
  } catch (error) {
    return {
      status: "failed",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      errorMessage: clipMessagingValidationError(
        scrubBotToken(error instanceof Error ? error.message : String(error)),
      ),
    };
  }
}

/**
 * Format a stable, human-readable identity for a Telegram bot. Bots
 * are required by Telegram to have a username, so the first branch is
 * the common path. The chained fallbacks are defensive cover for SDK
 * shape drift or partial responses (`getMe` returns the bot's
 * `User` object whose only required fields per the Telegram contract
 * are `id`, `is_bot`, and `first_name`).
 */
function formatAccount(me: {
  id?: number;
  username?: string;
  first_name?: string;
}): string {
  if (me.username) return `@${me.username}`;
  if (me.first_name) return me.first_name;
  if (typeof me.id === "number") return `Bot #${me.id}`;
  return "Telegram bot";
}

/**
 * Strip `/bot<token>` URL fragments from an arbitrary error message
 * so a network-layer failure can't surface the bot token to the
 * renderer or logs. The replacement preserves the surrounding URL
 * shape (`/bot<redacted>/getMe`) so the message stays diagnostically
 * useful.
 *
 * Exported for direct testing — not part of the public package API.
 */
export function scrubBotToken(message: string): string {
  return message.replace(/\/bot[^/\s]+/g, "/bot<redacted>");
}
