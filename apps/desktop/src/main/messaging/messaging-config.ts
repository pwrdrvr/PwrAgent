import type { DiscordMessagingConfig } from "@pwragnt/messaging-provider-discord";
import type { TelegramMessagingConfig } from "@pwragnt/messaging-provider-telegram";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  readEnvBoolean,
} from "../settings/desktop-settings-env";

export {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
};

export type DesktopMessagingConfig = {
  discord?: DiscordMessagingConfig;
  telegram?: TelegramMessagingConfig;
};

export type DesktopMessagingSettingsSource = Pick<
  DesktopSettingsService,
  "readSettings" | "resolveDiscordBotTokenSync" | "resolveTelegramBotTokenSync"
>;

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
            enabled: true,
            botToken: telegramBotToken,
            authorizedActorIds: telegramAuthorizedActorIds,
          },
        }
      : {}),
    ...(discordBotToken && discordAuthorizedActorIds.length > 0
      ? {
          discord: {
            channel: "discord" as const,
            enabled: true,
            botToken: discordBotToken,
            applicationId: readEnv(env, DISCORD_APPLICATION_ID_ENV),
            authorizedActorIds: discordAuthorizedActorIds,
          },
        }
      : {}),
  };
}

export async function loadDesktopMessagingConfigFromSettings(
  settings: DesktopMessagingSettingsSource,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopMessagingConfig> {
  const snapshot = await settings.readSettings();
  const envConfig = loadDesktopMessagingConfig(env);
  const telegramBotToken =
    envConfig.telegram?.botToken ?? settings.resolveTelegramBotTokenSync();
  const discordBotToken =
    envConfig.discord?.botToken ?? settings.resolveDiscordBotTokenSync();
  const telegramAuthorizedActorIds =
    envConfig.telegram?.authorizedActorIds
    ?? snapshot.messaging.telegram.authorizedUserIds.value;
  const discordAuthorizedActorIds =
    envConfig.discord?.authorizedActorIds
    ?? snapshot.messaging.discord.authorizedUserIds.value;

  return {
    ...(shouldEnableSettingsChannel(
      snapshot.messaging.telegram.enabled.value,
      envConfig.telegram,
      env,
      TELEGRAM_ENABLED_ENV,
    )
    && telegramBotToken
    && telegramAuthorizedActorIds.length > 0
      ? {
          telegram: {
            channel: "telegram" as const,
            enabled: true,
            botToken: telegramBotToken,
            authorizedActorIds: telegramAuthorizedActorIds,
          },
        }
      : {}),
    ...(shouldEnableSettingsChannel(
      snapshot.messaging.discord.enabled.value,
      envConfig.discord,
      env,
      DISCORD_ENABLED_ENV,
    )
    && discordBotToken
    && discordAuthorizedActorIds.length > 0
      ? {
          discord: {
            channel: "discord" as const,
            enabled: true,
            botToken: discordBotToken,
            applicationId:
              (envConfig.discord?.applicationId
                ?? snapshot.messaging.discord.applicationId.value)
              || undefined,
            authorizedActorIds: discordAuthorizedActorIds,
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
          enabled: config.telegram.enabled !== false,
          botToken: "[REDACTED]",
          authorizedActorCount: config.telegram.authorizedActorIds.length,
        }
      : undefined,
    discord: config.discord
      ? {
          channel: config.discord.channel,
          enabled: config.discord.enabled !== false,
          applicationId: config.discord.applicationId,
          botToken: "[REDACTED]",
          authorizedActorCount: config.discord.authorizedActorIds.length,
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

function shouldEnableSettingsChannel<TConfig>(
  settingsEnabled: boolean,
  envConfig: TConfig | undefined,
  env: NodeJS.ProcessEnv,
  enabledEnvKey: string,
): boolean {
  const envEnabled = readEnvBoolean(env, enabledEnvKey).value;
  if (envEnabled !== undefined) {
    return envEnabled;
  }

  return settingsEnabled || Boolean(envConfig);
}
