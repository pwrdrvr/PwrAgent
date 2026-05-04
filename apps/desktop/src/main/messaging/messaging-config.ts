import type { DiscordMessagingConfig } from "@pwragent/messaging-provider-discord";
import type { TelegramMessagingConfig } from "@pwragent/messaging-provider-telegram";
import type { MessagingToolUpdateMode } from "@pwragent/shared";
import type { MessagingAttachmentPolicy } from "./core/messaging-attachment-processor";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getMainLogger } from "../log";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
  readEnvBoolean,
  readEnvInteger,
  readEnvMessagingImageProfile,
} from "../settings/desktop-settings-env";

export {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
};

export type DesktopMessagingConfig = {
  attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  discord?: DiscordMessagingConfig;
  inputDebounceMs?: number;
  telegram?: TelegramMessagingConfig;
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
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
  const attachmentPolicy = readAttachmentPolicyFromEnv(env);

  return {
    inputDebounceMs: readInputDebounceMsFromEnv(env) ?? 500,
    toolUpdateDefaultMode: "show_some",
    ...(attachmentPolicy ? { attachmentPolicy } : {}),
    ...(telegramBotToken && telegramAuthorizedActorIds.length > 0
      ? {
          telegram: {
            channel: "telegram" as const,
            enabled: true,
            botToken: telegramBotToken,
            streamingResponses: readEnvBoolean(
              env,
              TELEGRAM_STREAMING_RESPONSES_ENV,
            ).value ?? false,
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
            streamingResponses: readEnvBoolean(
              env,
              DISCORD_STREAMING_RESPONSES_ENV,
            ).value ?? false,
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
  const log = getMainLogger("pwragent:messaging");
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
  const attachmentPolicy: Partial<MessagingAttachmentPolicy> = {
    imageProfile: snapshot.messaging.attachments.imageProfile.value,
    maxAttachmentBytes: snapshot.messaging.attachments.maxAttachmentBytes.value,
    maxAttachmentCount: snapshot.messaging.attachments.maxAttachmentCount.value,
  };

  // Resolve per-platform enablement and log the decision for each
  const telegramEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.telegram.enabled.value,
    envConfig.telegram,
    env,
    TELEGRAM_ENABLED_ENV,
  );
  const discordEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.discord.enabled.value,
    envConfig.discord,
    env,
    DISCORD_ENABLED_ENV,
  );

  const telegramConfig = buildChannelConfig({
    log,
    channel: "telegram",
    enabled: telegramEnabled,
    hasToken: Boolean(telegramBotToken),
    authorizedActorCount: telegramAuthorizedActorIds.length,
  })
    ? {
        telegram: {
          channel: "telegram" as const,
          enabled: true,
          botToken: telegramBotToken!,
          streamingResponses: snapshot.messaging.telegram.streamingResponses.value,
          authorizedActorIds: telegramAuthorizedActorIds,
        },
      }
    : {};

  const discordConfig = buildChannelConfig({
    log,
    channel: "discord",
    enabled: discordEnabled,
    hasToken: Boolean(discordBotToken),
    authorizedActorCount: discordAuthorizedActorIds.length,
  })
    ? {
        discord: {
          channel: "discord" as const,
          enabled: true,
          botToken: discordBotToken!,
          applicationId:
            (envConfig.discord?.applicationId
              ?? snapshot.messaging.discord.applicationId.value)
            || undefined,
          streamingResponses: snapshot.messaging.discord.streamingResponses.value,
          authorizedActorIds: discordAuthorizedActorIds,
        },
      }
    : {};

  return {
    inputDebounceMs: snapshot.messaging.inputDebounceMs.value,
    toolUpdateDefaultMode: snapshot.messaging.toolUpdateMode.value,
    attachmentPolicy,
    ...telegramConfig,
    ...discordConfig,
  };
}

/**
 * Evaluate whether a messaging channel can start, logging the decision clearly.
 * Returns true only when the channel is enabled, has a token, and has authorized actors.
 */
function buildChannelConfig(params: {
  log: ReturnType<typeof getMainLogger>;
  channel: string;
  enabled: boolean;
  hasToken: boolean;
  authorizedActorCount: number;
}): boolean {
  const { log, channel, enabled, hasToken, authorizedActorCount } = params;

  if (!enabled) {
    log.info(`${channel}: disabled in settings — skipping`, {
      channel,
    });
    return false;
  }

  // Channel is enabled — any missing prerequisite is an error
  if (!hasToken) {
    log.error(
      `${channel}: enabled but bot token is missing or could not be decrypted — cannot start`,
      { channel },
    );
    return false;
  }

  if (authorizedActorCount === 0) {
    log.error(
      `${channel}: enabled but no authorized user IDs configured — cannot start`,
      { channel },
    );
    return false;
  }

  log.info(`${channel}: enabled — will attempt to start`, {
    channel,
    authorizedActorCount,
  });
  return true;
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
          streamingResponses: config.telegram.streamingResponses ?? false,
          authorizedActorCount: config.telegram.authorizedActorIds.length,
        }
      : undefined,
    toolUpdateDefaultMode: config.toolUpdateDefaultMode ?? "show_some",
    inputDebounceMs: config.inputDebounceMs ?? 500,
    discord: config.discord
      ? {
          channel: config.discord.channel,
          enabled: config.discord.enabled !== false,
          applicationId: config.discord.applicationId,
          botToken: "[REDACTED]",
          streamingResponses: config.discord.streamingResponses ?? false,
          authorizedActorCount: config.discord.authorizedActorIds.length,
        }
      : undefined,
    attachmentPolicy: config.attachmentPolicy,
  };
}

function readInputDebounceMsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const value = readEnvInteger(env, MESSAGING_INPUT_DEBOUNCE_MS_ENV).value;
  return value === undefined ? undefined : Math.min(value, 5_000);
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

function readAttachmentPolicyFromEnv(
  env: NodeJS.ProcessEnv,
): Partial<MessagingAttachmentPolicy> | undefined {
  const imageProfile = readEnvMessagingImageProfile(env).value;
  const maxAttachmentBytes = readEnvInteger(
    env,
    MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  ).value;
  const maxAttachmentCount = readEnvInteger(
    env,
    MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  ).value;
  const policy: Partial<MessagingAttachmentPolicy> = {
    ...(imageProfile ? { imageProfile } : {}),
    ...(maxAttachmentBytes !== undefined ? { maxAttachmentBytes } : {}),
    ...(maxAttachmentCount !== undefined ? { maxAttachmentCount } : {}),
  };
  return Object.keys(policy).length > 0 ? policy : undefined;
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
