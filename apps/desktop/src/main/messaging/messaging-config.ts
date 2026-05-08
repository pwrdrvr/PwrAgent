import type { DiscordMessagingConfig } from "@pwragent/messaging-provider-discord";
import type { MattermostMessagingConfig } from "@pwragent/messaging-provider-mattermost";
import type { TelegramMessagingConfig } from "@pwragent/messaging-provider-telegram";
import type { MessagingToolUpdateMode } from "@pwragent/shared";
import type { MessagingAttachmentPolicy } from "./core/messaging-attachment-processor";
import type { DesktopSettingsService } from "../settings/desktop-settings-service";
import { getMainLogger } from "../log";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  MATTERMOST_AUTHORIZED_USER_IDS_ENV,
  MATTERMOST_BOT_TOKEN_ENV,
  MATTERMOST_CALLBACK_BASE_URL_ENV,
  MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
  MATTERMOST_ENABLED_ENV,
  MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
  MATTERMOST_SERVER_URL_ENV,
  MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
  MATTERMOST_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
  readEnvBoolean,
  readEnvInteger,
  readEnvMessagingImageProfile,
} from "../settings/desktop-settings-env";

export {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  MATTERMOST_AUTHORIZED_USER_IDS_ENV,
  MATTERMOST_BOT_TOKEN_ENV,
  MATTERMOST_CALLBACK_BASE_URL_ENV,
  MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
  MATTERMOST_ENABLED_ENV,
  MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
  MATTERMOST_SERVER_URL_ENV,
  MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
  MATTERMOST_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
};

export type DesktopMessagingConfig = {
  attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  discord?: DiscordMessagingConfig;
  enabled?: boolean;
  inputDebounceMs?: number;
  mattermost?: MattermostMessagingConfig;
  telegram?: TelegramMessagingConfig;
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
};

export type DesktopMessagingSettingsSource = Pick<
  DesktopSettingsService,
  | "readSettings"
  | "resolveDiscordBotTokenSync"
  | "resolveTelegramBotTokenSync"
  | "resolveMattermostBotTokenSync"
  | "resolveMattermostHmacSecretSync"
>;

export type DesktopMessagingConfigLoadOptions = {
  logStartupEligibility?: boolean;
  messagingEnabledOverride?: boolean;
};

export function loadDesktopMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): DesktopMessagingConfig {
  const telegramBotToken = readEnv(env, TELEGRAM_BOT_TOKEN_ENV, "TELEGRAM_BOT_TOKEN");
  const telegramAuthorizedActorIds = parseContactList(env[TELEGRAM_AUTHORIZED_USER_IDS_ENV]);
  const telegramAuthorizedSupergroupIds = parseContactList(
    env[TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV],
  );
  const discordBotToken = readEnv(env, DISCORD_BOT_TOKEN_ENV, "DISCORD_BOT_TOKEN");
  const discordAuthorizedActorIds = parseContactList(env[DISCORD_AUTHORIZED_USER_IDS_ENV]);
  const discordAuthorizedGuildIds = parseContactList(env[DISCORD_AUTHORIZED_GUILDS_ENV]);
  const mattermostBotToken = readEnv(env, MATTERMOST_BOT_TOKEN_ENV);
  const mattermostServerUrl = readEnv(env, MATTERMOST_SERVER_URL_ENV);
  const mattermostCallbackBaseUrl = readEnv(env, MATTERMOST_CALLBACK_BASE_URL_ENV);
  const mattermostAuthorizedActorIds = parseContactList(
    env[MATTERMOST_AUTHORIZED_USER_IDS_ENV],
  );
  const mattermostCallbackHmacSecret = readEnv(
    env,
    MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
  );
  const mattermostSlashCommandPrefix = readEnv(
    env,
    MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
  );
  const mattermostRegisterSlashCommandsEnv = readEnvBoolean(
    env,
    MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
  ).value;
  const attachmentPolicy = readAttachmentPolicyFromEnv(env);

  return {
    enabled: true,
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
            authorizedSupergroupIds: telegramAuthorizedSupergroupIds,
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
            authorizedGuildIds: discordAuthorizedGuildIds,
          },
        }
      : {}),
    ...(mattermostBotToken
      && mattermostServerUrl
      && mattermostCallbackBaseUrl
      && mattermostAuthorizedActorIds.length > 0
      ? {
          mattermost: {
            channel: "mattermost" as const,
            enabled: true,
            botToken: mattermostBotToken,
            serverUrl: mattermostServerUrl,
            callbackBaseUrl: mattermostCallbackBaseUrl,
            ...(mattermostCallbackHmacSecret
              ? { callbackHmacSecret: mattermostCallbackHmacSecret }
              : {}),
            ...(mattermostSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: mattermostSlashCommandPrefix }
              : {}),
            ...(mattermostRegisterSlashCommandsEnv !== undefined
              ? { registerSlashCommands: mattermostRegisterSlashCommandsEnv }
              : {}),
            streamingResponses: readEnvBoolean(
              env,
              MATTERMOST_STREAMING_RESPONSES_ENV,
            ).value ?? false,
            authorizedActorIds: mattermostAuthorizedActorIds,
          },
        }
      : {}),
  };
}

export async function loadDesktopMessagingConfigFromSettings(
  settings: DesktopMessagingSettingsSource,
  env: NodeJS.ProcessEnv = process.env,
  options: DesktopMessagingConfigLoadOptions = {},
): Promise<DesktopMessagingConfig> {
  const log = getMainLogger("pwragent:messaging");
  const snapshot = await settings.readSettings();
  const envConfig = loadDesktopMessagingConfig(env);
  const telegramBotToken =
    envConfig.telegram?.botToken ?? settings.resolveTelegramBotTokenSync();
  const discordBotToken =
    envConfig.discord?.botToken ?? settings.resolveDiscordBotTokenSync();
  const mattermostBotToken =
    envConfig.mattermost?.botToken ?? settings.resolveMattermostBotTokenSync();
  const mattermostHmacSecret =
    envConfig.mattermost?.callbackHmacSecret
    ?? settings.resolveMattermostHmacSecretSync();
  const telegramAuthorizedActorIds =
    envConfig.telegram?.authorizedActorIds
    ?? snapshot.messaging.telegram.authorizedUserIds.value;
  const telegramAuthorizedSupergroupIds =
    envConfig.telegram?.authorizedSupergroupIds
    ?? snapshot.messaging.telegram.authorizedSupergroups.value;
  const discordAuthorizedActorIds =
    envConfig.discord?.authorizedActorIds
    ?? snapshot.messaging.discord.authorizedUserIds.value;
  const discordAuthorizedGuildIds =
    envConfig.discord?.authorizedGuildIds
    ?? snapshot.messaging.discord.authorizedGuilds.value;
  const mattermostAuthorizedActorIds =
    envConfig.mattermost?.authorizedActorIds
    ?? snapshot.messaging.mattermost.authorizedUserIds.value;
  const mattermostServerUrlRaw =
    envConfig.mattermost?.serverUrl
    || snapshot.messaging.mattermost.serverUrl.value
    || undefined;
  const mattermostCallbackBaseUrlRaw =
    envConfig.mattermost?.callbackBaseUrl
    || snapshot.messaging.mattermost.callbackBaseUrl.value
    || undefined;
  const mattermostServerUrl = normalizeMattermostUrl(
    mattermostServerUrlRaw,
    "serverUrl",
    log,
  );
  const mattermostCallbackBaseUrl = normalizeMattermostUrl(
    mattermostCallbackBaseUrlRaw,
    "callbackBaseUrl",
    log,
  );
  const mattermostSlashCommandPrefix =
    envConfig.mattermost?.slashCommandPrefix
    ?? snapshot.messaging.mattermost.slashCommandPrefix.value;
  const mattermostRegisterSlashCommands =
    envConfig.mattermost?.registerSlashCommands
    ?? snapshot.messaging.mattermost.registerSlashCommands.value;
  const attachmentPolicy: Partial<MessagingAttachmentPolicy> = {
    imageProfile: snapshot.messaging.attachments.imageProfile.value,
    maxAttachmentBytes: snapshot.messaging.attachments.maxAttachmentBytes.value,
    maxAttachmentCount: snapshot.messaging.attachments.maxAttachmentCount.value,
  };
  const messagingEnabled =
    options.messagingEnabledOverride ?? snapshot.messaging.enabled.value;

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
  const mattermostEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.mattermost.enabled.value,
    envConfig.mattermost,
    env,
    MATTERMOST_ENABLED_ENV,
  );

  const telegramConfig = messagingEnabled && buildChannelConfig({
    log,
    channel: "telegram",
    enabled: telegramEnabled,
    hasToken: Boolean(telegramBotToken),
    logStartupEligibility: options.logStartupEligibility === true,
    authorizedActorCount: telegramAuthorizedActorIds.length,
  })
    ? {
        telegram: {
          channel: "telegram" as const,
          enabled: true,
          botToken: telegramBotToken!,
          streamingResponses: snapshot.messaging.telegram.streamingResponses.value,
          authorizedActorIds: telegramAuthorizedActorIds,
          authorizedSupergroupIds: telegramAuthorizedSupergroupIds,
        },
      }
    : {};

  const discordConfig = messagingEnabled && buildChannelConfig({
    log,
    channel: "discord",
    enabled: discordEnabled,
    hasToken: Boolean(discordBotToken),
    logStartupEligibility: options.logStartupEligibility === true,
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
          authorizedGuildIds: discordAuthorizedGuildIds,
        },
      }
    : {};

  const mattermostConfig =
    messagingEnabled
    && buildChannelConfig({
      log,
      channel: "mattermost",
      enabled: mattermostEnabled,
      hasToken: Boolean(mattermostBotToken),
      logStartupEligibility: options.logStartupEligibility === true,
      authorizedActorCount: mattermostAuthorizedActorIds.length,
    })
    && mattermostServerUrl
    && mattermostCallbackBaseUrl
      ? {
          mattermost: {
            channel: "mattermost" as const,
            enabled: true,
            botToken: mattermostBotToken!,
            serverUrl: mattermostServerUrl,
            callbackBaseUrl: mattermostCallbackBaseUrl,
            ...(mattermostHmacSecret
              ? { callbackHmacSecret: mattermostHmacSecret }
              : {}),
            ...(mattermostSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: mattermostSlashCommandPrefix }
              : {}),
            registerSlashCommands: mattermostRegisterSlashCommands,
            streamingResponses:
              snapshot.messaging.mattermost.streamingResponses.value,
            authorizedActorIds: mattermostAuthorizedActorIds,
          },
        }
      : {};

  return {
    enabled: messagingEnabled,
    inputDebounceMs: snapshot.messaging.inputDebounceMs.value,
    toolUpdateDefaultMode: snapshot.messaging.toolUpdateMode.value,
    attachmentPolicy,
    ...telegramConfig,
    ...discordConfig,
    ...mattermostConfig,
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
  logStartupEligibility: boolean;
  authorizedActorCount: number;
}): boolean {
  const { log, channel, enabled, hasToken, logStartupEligibility, authorizedActorCount } =
    params;

  if (!enabled) {
    if (logStartupEligibility) {
      log.info(`${channel}: disabled in settings — skipping`, {
        channel,
      });
    }
    return false;
  }

  // Channel is enabled — any missing prerequisite is an error
  if (!hasToken) {
    if (logStartupEligibility) {
      log.error(
        `${channel}: enabled but bot token is missing or could not be decrypted — cannot start`,
        { channel },
      );
    }
    return false;
  }

  if (authorizedActorCount === 0) {
    if (logStartupEligibility) {
      log.error(
        `${channel}: enabled but no authorized user IDs configured — cannot start`,
        { channel },
      );
    }
    return false;
  }

  if (logStartupEligibility) {
    log.info(`${channel}: enabled — will attempt to start`, {
      channel,
      authorizedActorCount,
    });
  }
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
    enabled: config.enabled !== false,
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
    mattermost: config.mattermost
      ? {
          channel: config.mattermost.channel,
          enabled: config.mattermost.enabled !== false,
          serverUrl: config.mattermost.serverUrl,
          callbackBaseUrl: config.mattermost.callbackBaseUrl,
          botToken: "[REDACTED]",
          callbackHmacSecret: config.mattermost.callbackHmacSecret
            ? "[REDACTED]"
            : "[GENERATED]",
          slashCommandPrefix: config.mattermost.slashCommandPrefix ?? "[default]",
          registerSlashCommands:
            config.mattermost.registerSlashCommands ?? false,
          streamingResponses: config.mattermost.streamingResponses ?? false,
          authorizedActorCount: config.mattermost.authorizedActorIds.length,
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

function parseContactList(value: string | undefined): Array<{
  id: string;
  displayName: string;
}> {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ].map((id) => ({ id, displayName: "" }));
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

/**
 * Normalize a Mattermost URL coming from settings or env vars.
 *
 * - Trims surrounding whitespace.
 * - Validates that it parses as a `http:` or `https:` URL — anything
 *   else (file:, ftp:, garbage strings) is rejected as invalid.
 * - Strips trailing slashes from the path so concatenation with API
 *   paths like `/api/v4/websocket` doesn't produce double slashes.
 *   The Mattermost websocket client builds its URL by string-appending
 *   `/api/v4/websocket` to the server URL; a single trailing slash on
 *   the input produces `ws://host:port//api/v4/websocket`, which the
 *   server rejects with a 1006 close. Normalize once at the boundary
 *   instead of trying to remember to strip on every concatenation.
 *
 * Returns `undefined` for empty / unparseable / non-http(s) input. The
 * adapter-startup gate already requires a non-undefined URL, so an
 * invalid URL fails closed (the adapter doesn't start) rather than
 * starting with broken state.
 */
export function normalizeMattermostUrl(
  input: string | undefined,
  fieldName: "serverUrl" | "callbackBaseUrl",
  log?: { warn: (msg: string, data?: Record<string, unknown>) => void },
): string | undefined {
  if (input === undefined) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    log?.warn("mattermost url is not a valid URL — disabling channel", {
      field: fieldName,
      value: trimmed,
    });
    return undefined;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    log?.warn("mattermost url has unsupported protocol — disabling channel", {
      field: fieldName,
      protocol: parsed.protocol,
    });
    return undefined;
  }

  // Reconstruct via the URL object so we get a single canonical form
  // (collapsed slashes, default-port stripping, etc.), then strip a
  // single trailing slash from the path so consumers can safely
  // string-concatenate `/api/v4/...`.
  const canonical = parsed.toString();
  return canonical.endsWith("/") ? canonical.slice(0, -1) : canonical;
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
