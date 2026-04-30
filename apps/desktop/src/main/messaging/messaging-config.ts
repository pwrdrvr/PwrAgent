import type { MessagingChannelKind } from "@pwragnt/shared";

export const TELEGRAM_BOT_TOKEN_ENV = "PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN";
export const TELEGRAM_AUTHORIZED_USER_IDS_ENV =
  "PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS";
export const DISCORD_BOT_TOKEN_ENV = "PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN";
export const DISCORD_APPLICATION_ID_ENV =
  "PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID";
export const DISCORD_AUTHORIZED_USER_IDS_ENV =
  "PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS";
export const DISCORD_MESSAGE_CONTENT_INTENT_ENV =
  "PWRAGNT_MESSAGING_DISCORD_MESSAGE_CONTENT_INTENT";

type MessagingChannelConfigBase = {
  authorizedActorIds: string[];
  channel: MessagingChannelKind;
};

export type TelegramMessagingConfig = MessagingChannelConfigBase & {
  botToken: string;
  channel: "telegram";
};

export type DiscordMessagingConfig = MessagingChannelConfigBase & {
  applicationId?: string;
  botToken: string;
  channel: "discord";
  messageContentIntent?: boolean;
};

export type DesktopMessagingConfig = {
  discord?: DiscordMessagingConfig;
  telegram?: TelegramMessagingConfig;
};

export function loadDesktopMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): DesktopMessagingConfig {
  const telegramBotToken = readEnv(env, TELEGRAM_BOT_TOKEN_ENV, "TELEGRAM_BOT_TOKEN");
  const telegramAuthorizedActorIds = parseList(env[TELEGRAM_AUTHORIZED_USER_IDS_ENV]);
  const discordBotToken = readEnv(env, DISCORD_BOT_TOKEN_ENV, "DISCORD_BOT_TOKEN");
  const discordAuthorizedActorIds = parseList(env[DISCORD_AUTHORIZED_USER_IDS_ENV]);

  return {
    ...(telegramBotToken && telegramAuthorizedActorIds.length > 0
      ? {
          telegram: {
            channel: "telegram" as const,
            botToken: telegramBotToken,
            authorizedActorIds: telegramAuthorizedActorIds,
          },
        }
      : {}),
    ...(discordBotToken && discordAuthorizedActorIds.length > 0
      ? {
          discord: {
            channel: "discord" as const,
            botToken: discordBotToken,
            applicationId: readEnv(env, DISCORD_APPLICATION_ID_ENV),
            authorizedActorIds: discordAuthorizedActorIds,
            messageContentIntent: parseBoolean(
              env[DISCORD_MESSAGE_CONTENT_INTENT_ENV],
            ),
          },
        }
      : {}),
  };
}

export function redactDesktopMessagingConfig(
  config: DesktopMessagingConfig,
): Record<string, unknown> {
  return {
    telegram: config.telegram
      ? {
          channel: config.telegram.channel,
          botToken: "[REDACTED]",
          authorizedActorCount: config.telegram.authorizedActorIds.length,
        }
      : undefined,
    discord: config.discord
      ? {
          channel: config.discord.channel,
          applicationId: config.discord.applicationId,
          botToken: "[REDACTED]",
          authorizedActorCount: config.discord.authorizedActorIds.length,
          messageContentIntent: config.discord.messageContentIntent,
        }
      : undefined,
  };
}

function readEnv(
  env: NodeJS.ProcessEnv,
  primary: string,
  fallback?: string,
): string | undefined {
  return env[primary]?.trim() || (fallback ? env[fallback]?.trim() : undefined);
}

function parseList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
