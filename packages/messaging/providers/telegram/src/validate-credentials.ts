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
    const account = me.username ? `@${me.username}` : me.first_name;
    return {
      status: "ok",
      durationMs: Date.now() - startedAt,
      testedAt: Date.now(),
      account,
      detail: "api.telegram.org",
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
