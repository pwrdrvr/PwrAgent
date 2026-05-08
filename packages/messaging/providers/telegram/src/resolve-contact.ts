import { Bot } from "grammy";
import {
  clipMessagingValidationError,
  type MessagingContactLookupRequest,
  type MessagingContactLookupResult,
} from "@pwragent/messaging-interface";
import type { TelegramMessagingConfig } from "./telegram-config.ts";

type TelegramLookupBotLike = {
  api: {
    getChat(chatId: number | string): Promise<TelegramLookupChat>;
  };
};

type TelegramLookupChat = {
  first_name?: string;
  last_name?: string;
  title?: string;
  type?: string;
  username?: string;
};

export type TelegramResolveContactOptions = {
  bot?: TelegramLookupBotLike;
};

export async function resolveContact(
  config: Pick<TelegramMessagingConfig, "botToken">,
  request: MessagingContactLookupRequest,
  options: TelegramResolveContactOptions = {},
): Promise<MessagingContactLookupResult> {
  if (!config.botToken) {
    return { status: "unset", id: request.id };
  }
  if (request.kind !== "user" && request.kind !== "supergroup") {
    return {
      status: "unsupported",
      id: request.id,
      errorMessage: `Telegram cannot resolve ${request.kind} contacts.`,
    };
  }

  try {
    const bot = options.bot ?? new Bot(config.botToken);
    const chat = await bot.api.getChat(request.id);
    return {
      status: "ok",
      id: request.id,
      displayName: formatTelegramDisplayName(chat),
      handle: chat.username ? `@${chat.username}` : undefined,
      detail: chat.type,
    };
  } catch (error) {
    return lookupFailure(request.id, error);
  }
}

function formatTelegramDisplayName(chat: TelegramLookupChat): string | undefined {
  const name =
    [chat.first_name, chat.last_name].filter(Boolean).join(" ")
    || chat.title
    || undefined;
  const handle = chat.username ? `@${chat.username}` : undefined;
  if (name && handle) return `${name} (${handle})`;
  return name ?? handle;
}

function lookupFailure(id: string, error: unknown): MessagingContactLookupResult {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\b(400|403|404)\b|not found|chat not found/i.test(message)
    ? "not_found"
    : "failed";
  return {
    status,
    id,
    errorMessage: clipMessagingValidationError(message),
  };
}
