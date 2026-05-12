import type { DiscordMessagingConfig } from "@pwragent/messaging-provider-discord";
import type { FeishuMessagingConfig } from "@pwragent/messaging-provider-feishu";
import type { LineMessagingConfig } from "@pwragent/messaging-provider-line";
import type { MattermostMessagingConfig } from "@pwragent/messaging-provider-mattermost";
import type { SlackMessagingConfig } from "@pwragent/messaging-provider-slack";
import type { TelegramMessagingConfig } from "@pwragent/messaging-provider-telegram";
import type { MessagingToolUpdateMode } from "@pwragent/shared";
import type {
  MessagingAdapterAuthorizationUpdate,
  MessagingAdapterRenderingPreferencesUpdate,
} from "@pwragent/messaging-interface";
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
  FEISHU_APP_ID_ENV,
  FEISHU_APP_SECRET_ENV,
  FEISHU_AUTHORIZED_CHATS_ENV,
  FEISHU_AUTHORIZED_TENANTS_ENV,
  FEISHU_AUTHORIZED_USER_IDS_ENV,
  FEISHU_CALLBACK_BASE_URL_ENV,
  FEISHU_ENABLED_ENV,
  FEISHU_ENCRYPT_KEY_ENV,
  FEISHU_INBOUND_MODE_ENV,
  FEISHU_REGISTER_SLASH_COMMANDS_ENV,
  FEISHU_SLASH_COMMAND_PREFIX_ENV,
  FEISHU_STREAMING_RESPONSES_ENV,
  FEISHU_TENANT_REGION_ENV,
  FEISHU_TENANT_URL_ENV,
  FEISHU_VERIFICATION_TOKEN_ENV,
  LINE_AUTHORIZED_GROUPS_ENV,
  LINE_AUTHORIZED_ROOMS_ENV,
  LINE_AUTHORIZED_USER_IDS_ENV,
  LINE_BOT_USER_ID_ENV,
  LINE_CALLBACK_BASE_URL_ENV,
  LINE_CHANNEL_ACCESS_TOKEN_ENV,
  LINE_CHANNEL_SECRET_ENV,
  LINE_ENABLED_ENV,
  LINE_STREAMING_RESPONSES_ENV,
  LINE_WEBHOOK_URL_ENV,
  MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
  MATTERMOST_AUTHORIZED_TEAMS_ENV,
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
  SLACK_APP_TOKEN_ENV,
  SLACK_AUTHORIZED_USER_IDS_ENV,
  SLACK_AUTHORIZED_WORKSPACES_ENV,
  SLACK_BOT_TOKEN_ENV,
  SLACK_ENABLED_ENV,
  SLACK_INBOUND_MODE_ENV,
  SLACK_REGISTER_SLASH_COMMANDS_ENV,
  SLACK_SIGNING_SECRET_ENV,
  SLACK_SLASH_COMMAND_PREFIX_ENV,
  SLACK_STREAMING_RESPONSES_ENV,
  SLACK_WORKSPACE_URL_ENV,
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
  FEISHU_APP_ID_ENV,
  FEISHU_APP_SECRET_ENV,
  FEISHU_AUTHORIZED_CHATS_ENV,
  FEISHU_AUTHORIZED_TENANTS_ENV,
  FEISHU_AUTHORIZED_USER_IDS_ENV,
  FEISHU_CALLBACK_BASE_URL_ENV,
  FEISHU_ENABLED_ENV,
  FEISHU_ENCRYPT_KEY_ENV,
  FEISHU_REGISTER_SLASH_COMMANDS_ENV,
  FEISHU_SLASH_COMMAND_PREFIX_ENV,
  FEISHU_STREAMING_RESPONSES_ENV,
  FEISHU_TENANT_REGION_ENV,
  FEISHU_TENANT_URL_ENV,
  FEISHU_VERIFICATION_TOKEN_ENV,
  LINE_AUTHORIZED_GROUPS_ENV,
  LINE_AUTHORIZED_ROOMS_ENV,
  LINE_AUTHORIZED_USER_IDS_ENV,
  LINE_BOT_USER_ID_ENV,
  LINE_CALLBACK_BASE_URL_ENV,
  LINE_CHANNEL_ACCESS_TOKEN_ENV,
  LINE_CHANNEL_SECRET_ENV,
  LINE_ENABLED_ENV,
  LINE_STREAMING_RESPONSES_ENV,
  LINE_WEBHOOK_URL_ENV,
  MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
  MATTERMOST_AUTHORIZED_TEAMS_ENV,
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
  SLACK_APP_TOKEN_ENV,
  SLACK_AUTHORIZED_USER_IDS_ENV,
  SLACK_AUTHORIZED_WORKSPACES_ENV,
  SLACK_BOT_TOKEN_ENV,
  SLACK_ENABLED_ENV,
  SLACK_INBOUND_MODE_ENV,
  SLACK_REGISTER_SLASH_COMMANDS_ENV,
  SLACK_SIGNING_SECRET_ENV,
  SLACK_SLASH_COMMAND_PREFIX_ENV,
  SLACK_STREAMING_RESPONSES_ENV,
  SLACK_WORKSPACE_URL_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
};

export const LINE_DEFAULT_CALLBACK_BASE_URL = "http://127.0.0.1:47822";
export const FEISHU_DEFAULT_CALLBACK_BASE_URL = "http://127.0.0.1:47823";
export const FEISHU_DEFAULT_TENANT_URL = "https://open.feishu.cn";
export const LARK_DEFAULT_TENANT_URL = "https://open.larksuite.com";

export type DesktopMessagingConfig = {
  attachmentPolicy?: Partial<MessagingAttachmentPolicy>;
  discord?: DiscordMessagingConfig;
  enabled?: boolean;
  feishu?: FeishuMessagingConfig;
  inputDebounceMs?: number;
  line?: LineMessagingConfig;
  mattermost?: MattermostMessagingConfig;
  slack?: SlackMessagingConfig;
  telegram?: TelegramMessagingConfig;
  toolUpdateDefaultMode?: MessagingToolUpdateMode;
};

export type DesktopMessagingConfigFieldImpact =
  | "authorization"
  | "connection"
  | "irrelevant"
  | "rendering";

export const DESKTOP_MESSAGING_ROOT_CONFIG_FIELD_IMPACTS = {
  attachmentPolicy: "connection",
  discord: "connection",
  enabled: "connection",
  feishu: "connection",
  inputDebounceMs: "connection",
  line: "connection",
  mattermost: "connection",
  slack: "connection",
  telegram: "connection",
  toolUpdateDefaultMode: "irrelevant",
} as const satisfies Record<
  keyof DesktopMessagingConfig,
  DesktopMessagingConfigFieldImpact
>;

export const DESKTOP_MESSAGING_CHANNEL_CONFIG_FIELD_IMPACTS = {
  telegram: {
    authorizedActorIds: "authorization",
    authorizedSupergroupIds: "authorization",
    botToken: "connection",
    channel: "irrelevant",
    enabled: "connection",
    streamingResponses: "rendering",
  },
  discord: {
    applicationId: "connection",
    authorizedActorIds: "authorization",
    authorizedGuildIds: "authorization",
    botToken: "connection",
    channel: "irrelevant",
    enabled: "connection",
    streamingResponses: "rendering",
  },
  mattermost: {
    authorizedActorIds: "authorization",
    authorizedConversationIds: "authorization",
    authorizedTeamIds: "authorization",
    botToken: "connection",
    callbackBaseUrl: "connection",
    callbackHmacSecret: "connection",
    channel: "irrelevant",
    enabled: "connection",
    registerSlashCommands: "connection",
    serverUrl: "connection",
    slashCommandPrefix: "connection",
    streamingResponses: "rendering",
  },
  slack: {
    appToken: "connection",
    authorizedActorIds: "authorization",
    authorizedConversationIds: "authorization",
    authorizedTeamIds: "authorization",
    botToken: "connection",
    channel: "irrelevant",
    enabled: "connection",
    inboundMode: "connection",
    registerSlashCommands: "connection",
    signingSecret: "connection",
    slashCommandPrefix: "connection",
    streamingResponses: "rendering",
    workspaceUrl: "connection",
  },
  feishu: {
    appId: "connection",
    appSecret: "connection",
    authorizedActorIds: "authorization",
    authorizedChatIds: "authorization",
    authorizedTenantKeys: "authorization",
    callbackBaseUrl: "connection",
    channel: "irrelevant",
    enabled: "connection",
    encryptKey: "connection",
    inboundMode: "connection",
    registerSlashCommands: "connection",
    slashCommandPrefix: "connection",
    streamingResponses: "rendering",
    tenantRegion: "connection",
    tenantUrl: "connection",
    verificationToken: "connection",
  },
  line: {
    authorizedActorIds: "authorization",
    authorizedGroupIds: "authorization",
    authorizedRoomIds: "authorization",
    botUserId: "connection",
    callbackBaseUrl: "connection",
    channel: "irrelevant",
    channelAccessToken: "connection",
    channelSecret: "connection",
    enabled: "connection",
    streamingResponses: "rendering",
    webhookPath: "connection",
    webhookUrl: "connection",
  },
} as const satisfies {
  telegram: Record<keyof TelegramMessagingConfig, DesktopMessagingConfigFieldImpact>;
  discord: Record<keyof DiscordMessagingConfig, DesktopMessagingConfigFieldImpact>;
  mattermost: Record<
    keyof MattermostMessagingConfig,
    DesktopMessagingConfigFieldImpact
  >;
  slack: Record<keyof SlackMessagingConfig, DesktopMessagingConfigFieldImpact>;
  feishu: Record<keyof FeishuMessagingConfig, DesktopMessagingConfigFieldImpact>;
  line: Record<keyof LineMessagingConfig, DesktopMessagingConfigFieldImpact>;
};

export type DesktopMessagingConfigChannel =
  keyof typeof DESKTOP_MESSAGING_CHANNEL_CONFIG_FIELD_IMPACTS;

export type DesktopMessagingChannelConfigUpdate =
  | {
      action: "unchanged";
      changedFields: readonly string[];
    }
  | {
      action: "hot";
      authorization?: MessagingAdapterAuthorizationUpdate;
      changedFields: readonly string[];
      renderingPreferences?: MessagingAdapterRenderingPreferencesUpdate;
    }
  | {
      action: "restart";
      changedFields: readonly string[];
      restartFields: readonly string[];
    };

export type DesktopMessagingSettingsSource = Pick<
  DesktopSettingsService,
  | "readSettings"
  | "resolveDiscordBotTokenSync"
  | "resolveTelegramBotTokenSync"
  | "resolveMattermostBotTokenSync"
  | "resolveMattermostHmacSecretSync"
  | "resolveSlackAppTokenSync"
  | "resolveSlackBotTokenSync"
  | "resolveSlackSigningSecretSync"
  | "resolveFeishuAppIdSync"
  | "resolveFeishuAppSecretSync"
  | "resolveFeishuEncryptKeySync"
  | "resolveFeishuVerificationTokenSync"
  | "resolveLineChannelAccessTokenSync"
  | "resolveLineChannelSecretSync"
>;

export type DesktopMessagingConfigLoadOptions = {
  logStartupEligibility?: boolean;
  messagingEnabledOverride?: boolean;
};

export function classifyDesktopMessagingChannelConfigUpdate(
  previous: DesktopMessagingConfig,
  next: DesktopMessagingConfig,
  channel: DesktopMessagingConfigChannel,
): DesktopMessagingChannelConfigUpdate {
  const changedFields: string[] = [];
  const restartFields: string[] = [];

  for (const field of ["attachmentPolicy", "inputDebounceMs"] as const) {
    if (
      stableMessagingConfigStringify(previous[field])
      === stableMessagingConfigStringify(next[field])
    ) {
      continue;
    }
    changedFields.push(field);
    restartFields.push(field);
  }

  const previousChannelConfig = previous[channel];
  const nextChannelConfig = next[channel];
  if (!previousChannelConfig && !nextChannelConfig) {
    return restartFields.length > 0
      ? { action: "restart", changedFields, restartFields }
      : { action: "unchanged", changedFields };
  }
  if (!previousChannelConfig || !nextChannelConfig) {
    const field = channel;
    changedFields.push(field);
    restartFields.push(field);
    return { action: "restart", changedFields, restartFields };
  }

  const impacts = DESKTOP_MESSAGING_CHANNEL_CONFIG_FIELD_IMPACTS[channel];
  const fieldNames = new Set([
    ...Object.keys(previousChannelConfig),
    ...Object.keys(nextChannelConfig),
  ]);
  let authorizationChanged = false;
  let renderingChanged = false;

  for (const fieldName of [...fieldNames].sort()) {
    const impact = impacts[fieldName as keyof typeof impacts];
    const previousValue = previousChannelConfig[
      fieldName as keyof typeof previousChannelConfig
    ];
    const nextValue = nextChannelConfig[fieldName as keyof typeof nextChannelConfig];
    if (
      stableMessagingConfigStringify(previousValue)
      === stableMessagingConfigStringify(nextValue)
    ) {
      continue;
    }

    const qualifiedField = `${channel}.${fieldName}`;
    changedFields.push(qualifiedField);
    if (impact === "authorization") {
      authorizationChanged = true;
    } else if (impact === "rendering") {
      renderingChanged = true;
    } else if (impact === "connection" || impact === undefined) {
      restartFields.push(qualifiedField);
    }
  }

  if (restartFields.length > 0) {
    return { action: "restart", changedFields, restartFields };
  }
  if (authorizationChanged || renderingChanged) {
    return {
      action: "hot",
      changedFields,
      ...(authorizationChanged
        ? { authorization: authorizationUpdateForChannelConfig(next, channel) }
        : {}),
      ...(renderingChanged
        ? { renderingPreferences: renderingPreferencesForChannelConfig(next, channel) }
        : {}),
    };
  }
  return { action: "unchanged", changedFields };
}

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
  const mattermostAuthorizedTeamIds = parseContactList(
    env[MATTERMOST_AUTHORIZED_TEAMS_ENV],
  );
  const mattermostAuthorizedConversationIds = parseContactList(
    env[MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV],
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
  const slackBotToken = readEnv(env, SLACK_BOT_TOKEN_ENV);
  const slackAppToken = readEnv(env, SLACK_APP_TOKEN_ENV);
  const slackSigningSecret = readEnv(env, SLACK_SIGNING_SECRET_ENV);
  const slackWorkspaceUrl = readEnv(env, SLACK_WORKSPACE_URL_ENV);
  const slackInboundMode = normalizeSlackRuntimeInboundMode(
    readSlackInboundMode(env[SLACK_INBOUND_MODE_ENV]),
  );
  const slackAuthorizedActorIds = parseContactList(env[SLACK_AUTHORIZED_USER_IDS_ENV]);
  const slackAuthorizedWorkspaces = parseContactList(
    env[SLACK_AUTHORIZED_WORKSPACES_ENV],
  );
  const slackSlashCommandPrefix = readEnv(env, SLACK_SLASH_COMMAND_PREFIX_ENV);
  const slackRegisterSlashCommandsEnv = readEnvBoolean(
    env,
    SLACK_REGISTER_SLASH_COMMANDS_ENV,
  ).value;
  const feishuAppId = readEnv(env, FEISHU_APP_ID_ENV);
  const feishuAppSecret = readEnv(env, FEISHU_APP_SECRET_ENV);
  const feishuInboundMode = readFeishuInboundMode(env[FEISHU_INBOUND_MODE_ENV]);
  const feishuTenantRegion = readFeishuTenantRegion(env[FEISHU_TENANT_REGION_ENV]);
  const feishuTenantUrl =
    readEnv(env, FEISHU_TENANT_URL_ENV)
    ?? tenantUrlForFeishuRegion(feishuTenantRegion);
  const feishuCallbackBaseUrl =
    readEnv(env, FEISHU_CALLBACK_BASE_URL_ENV) ?? FEISHU_DEFAULT_CALLBACK_BASE_URL;
  const feishuEncryptKey = readEnv(env, FEISHU_ENCRYPT_KEY_ENV);
  const feishuVerificationToken = readEnv(env, FEISHU_VERIFICATION_TOKEN_ENV);
  const feishuAuthorizedActorIds = parseContactList(
    env[FEISHU_AUTHORIZED_USER_IDS_ENV],
  );
  const feishuAuthorizedChatIds = parseContactList(env[FEISHU_AUTHORIZED_CHATS_ENV]);
  const feishuAuthorizedTenantKeys = parseContactList(
    env[FEISHU_AUTHORIZED_TENANTS_ENV],
  );
  const feishuSlashCommandPrefix = readEnv(env, FEISHU_SLASH_COMMAND_PREFIX_ENV);
  const feishuRegisterSlashCommandsEnv = readEnvBoolean(
    env,
    FEISHU_REGISTER_SLASH_COMMANDS_ENV,
  ).value;
  const lineChannelAccessToken = readEnv(env, LINE_CHANNEL_ACCESS_TOKEN_ENV);
  const lineChannelSecret = readEnv(env, LINE_CHANNEL_SECRET_ENV);
  const lineWebhookUrl = readEnv(env, LINE_WEBHOOK_URL_ENV);
  const lineCallbackBaseUrl =
    readEnv(env, LINE_CALLBACK_BASE_URL_ENV) ?? LINE_DEFAULT_CALLBACK_BASE_URL;
  const lineBotUserId = readEnv(env, LINE_BOT_USER_ID_ENV);
  const lineAuthorizedActorIds = parseContactList(env[LINE_AUTHORIZED_USER_IDS_ENV]);
  const lineAuthorizedGroupIds = parseContactList(env[LINE_AUTHORIZED_GROUPS_ENV]);
  const lineAuthorizedRoomIds = parseContactList(env[LINE_AUTHORIZED_ROOMS_ENV]);
  const attachmentPolicy = readAttachmentPolicyFromEnv(env);

  return {
    enabled: true,
    inputDebounceMs: readInputDebounceMsFromEnv(env) ?? 500,
    toolUpdateDefaultMode: "show_some",
    ...(attachmentPolicy ? { attachmentPolicy } : {}),
    ...(telegramBotToken
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
    ...(discordBotToken
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
            authorizedTeamIds: mattermostAuthorizedTeamIds,
            authorizedConversationIds: mattermostAuthorizedConversationIds,
          },
        }
      : {}),
    ...(slackBotToken
      && slackAppToken
      ? {
          slack: {
            channel: "slack" as const,
            enabled: true,
            botToken: slackBotToken,
            appToken: slackAppToken,
            ...(slackSigningSecret ? { signingSecret: slackSigningSecret } : {}),
            ...(slackWorkspaceUrl ? { workspaceUrl: slackWorkspaceUrl } : {}),
            inboundMode: slackInboundMode,
            ...(slackSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: slackSlashCommandPrefix }
              : {}),
            ...(slackRegisterSlashCommandsEnv !== undefined
              ? { registerSlashCommands: slackRegisterSlashCommandsEnv }
              : {}),
            streamingResponses: readEnvBoolean(
              env,
              SLACK_STREAMING_RESPONSES_ENV,
            ).value ?? false,
            authorizedActorIds: slackAuthorizedActorIds,
            authorizedTeamIds: slackAuthorizedWorkspaces,
          },
        }
      : {}),
    ...(feishuAppId
      && feishuAppSecret
      ? {
          feishu: {
            channel: "feishu" as const,
            enabled: true,
            appId: feishuAppId,
            appSecret: feishuAppSecret,
            inboundMode: feishuInboundMode,
            tenantRegion: feishuTenantRegion,
            tenantUrl: feishuTenantUrl,
            callbackBaseUrl: feishuCallbackBaseUrl,
            ...(feishuEncryptKey ? { encryptKey: feishuEncryptKey } : {}),
            ...(feishuVerificationToken
              ? { verificationToken: feishuVerificationToken }
              : {}),
            ...(feishuSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: feishuSlashCommandPrefix }
              : {}),
            ...(feishuRegisterSlashCommandsEnv !== undefined
              ? { registerSlashCommands: feishuRegisterSlashCommandsEnv }
              : {}),
            streamingResponses: readEnvBoolean(
              env,
              FEISHU_STREAMING_RESPONSES_ENV,
            ).value ?? false,
            authorizedActorIds: feishuAuthorizedActorIds,
            authorizedChatIds: feishuAuthorizedChatIds,
            authorizedTenantKeys: feishuAuthorizedTenantKeys,
          },
        }
      : {}),
    ...(lineChannelSecret
      && lineCallbackBaseUrl
      ? {
          line: {
            channel: "line" as const,
            enabled: true,
            channelSecret: lineChannelSecret,
            callbackBaseUrl: lineCallbackBaseUrl,
            ...(lineChannelAccessToken
              ? { channelAccessToken: lineChannelAccessToken }
              : {}),
            ...(lineWebhookUrl ? { webhookUrl: lineWebhookUrl } : {}),
            ...(lineBotUserId ? { botUserId: lineBotUserId } : {}),
            streamingResponses: readEnvBoolean(
              env,
              LINE_STREAMING_RESPONSES_ENV,
            ).value ?? false,
            authorizedActorIds: lineAuthorizedActorIds,
            authorizedGroupIds: lineAuthorizedGroupIds,
            authorizedRoomIds: lineAuthorizedRoomIds,
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
  const slackBotToken =
    envConfig.slack?.botToken ?? settings.resolveSlackBotTokenSync();
  const slackAppToken =
    envConfig.slack?.appToken ?? settings.resolveSlackAppTokenSync();
  const slackSigningSecret =
    envConfig.slack?.signingSecret ?? settings.resolveSlackSigningSecretSync();
  const feishuAppId =
    envConfig.feishu?.appId ?? settings.resolveFeishuAppIdSync();
  const feishuAppSecret =
    envConfig.feishu?.appSecret ?? settings.resolveFeishuAppSecretSync();
  const feishuEncryptKey =
    envConfig.feishu?.encryptKey ?? settings.resolveFeishuEncryptKeySync();
  const feishuVerificationToken =
    envConfig.feishu?.verificationToken
    ?? settings.resolveFeishuVerificationTokenSync();
  const lineChannelAccessToken =
    envConfig.line?.channelAccessToken
    ?? settings.resolveLineChannelAccessTokenSync();
  const lineChannelSecret =
    envConfig.line?.channelSecret ?? settings.resolveLineChannelSecretSync();
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
  const mattermostAuthorizedTeamIds =
    envConfig.mattermost?.authorizedTeamIds
    ?? snapshot.messaging.mattermost.authorizedTeams.value;
  const mattermostAuthorizedConversationIds =
    envConfig.mattermost?.authorizedConversationIds
    ?? snapshot.messaging.mattermost.authorizedConversations.value;
  const slackAuthorizedActorIds =
    envConfig.slack?.authorizedActorIds
    ?? snapshot.messaging.slack.authorizedUserIds.value;
  const slackAuthorizedTeamIds =
    envConfig.slack?.authorizedTeamIds
    ?? snapshot.messaging.slack.authorizedWorkspaces.value;
  const feishuAuthorizedActorIds =
    envConfig.feishu?.authorizedActorIds
    ?? snapshot.messaging.feishu.authorizedUserIds.value;
  const feishuAuthorizedChatIds =
    envConfig.feishu?.authorizedChatIds
    ?? snapshot.messaging.feishu.authorizedChats.value;
  const feishuAuthorizedTenantKeys =
    envConfig.feishu?.authorizedTenantKeys
    ?? snapshot.messaging.feishu.authorizedTenants.value;
  const lineAuthorizedActorIds =
    envConfig.line?.authorizedActorIds
    ?? snapshot.messaging.line.authorizedUserIds.value;
  const lineAuthorizedGroupIds =
    envConfig.line?.authorizedGroupIds
    ?? snapshot.messaging.line.authorizedGroups.value;
  const lineAuthorizedRoomIds =
    envConfig.line?.authorizedRoomIds
    ?? snapshot.messaging.line.authorizedRooms.value;
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
  const slackWorkspaceUrl =
    envConfig.slack?.workspaceUrl
    || snapshot.messaging.slack.workspaceUrl.value
    || undefined;
  const slackInboundMode = normalizeSlackRuntimeInboundMode(
    envConfig.slack?.inboundMode ?? snapshot.messaging.slack.inboundMode.value,
    log,
  );
  const slackSlashCommandPrefix =
    envConfig.slack?.slashCommandPrefix
    ?? snapshot.messaging.slack.slashCommandPrefix.value;
  const slackRegisterSlashCommands =
    envConfig.slack?.registerSlashCommands
    ?? snapshot.messaging.slack.registerSlashCommands.value;
  const feishuTenantRegion =
    envConfig.feishu?.tenantRegion ?? snapshot.messaging.feishu.tenantRegion.value;
  const feishuInboundMode =
    envConfig.feishu?.inboundMode ?? snapshot.messaging.feishu.inboundMode.value;
  const feishuTenantUrlRaw =
    envConfig.feishu?.tenantUrl
    || snapshot.messaging.feishu.tenantUrl.value
    || tenantUrlForFeishuRegion(feishuTenantRegion);
  const feishuTenantUrl = normalizeMattermostUrl(
    feishuTenantUrlRaw,
    "serverUrl",
    log,
  );
  const feishuCallbackBaseUrlRaw =
    envConfig.feishu?.callbackBaseUrl
    || snapshot.messaging.feishu.callbackBaseUrl.value
    || FEISHU_DEFAULT_CALLBACK_BASE_URL;
  const feishuCallbackBaseUrl = normalizeMattermostUrl(
    feishuCallbackBaseUrlRaw,
    "callbackBaseUrl",
    log,
  );
  const feishuSlashCommandPrefix =
    envConfig.feishu?.slashCommandPrefix
    ?? snapshot.messaging.feishu.slashCommandPrefix.value;
  const feishuRegisterSlashCommands =
    envConfig.feishu?.registerSlashCommands
    ?? snapshot.messaging.feishu.registerSlashCommands.value;
  const lineWebhookUrl =
    envConfig.line?.webhookUrl
    || snapshot.messaging.line.webhookUrl.value
    || undefined;
  const lineCallbackBaseUrlRaw =
    envConfig.line?.callbackBaseUrl
    || snapshot.messaging.line.callbackBaseUrl.value
    || LINE_DEFAULT_CALLBACK_BASE_URL;
  const lineCallbackBaseUrl = normalizeMattermostUrl(
    lineCallbackBaseUrlRaw,
    "callbackBaseUrl",
    log,
  );
  const lineBotUserId =
    envConfig.line?.botUserId
    || snapshot.messaging.line.botUserId.value
    || undefined;
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
  const slackEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.slack.enabled.value,
    envConfig.slack,
    env,
    SLACK_ENABLED_ENV,
  );
  const feishuEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.feishu.enabled.value,
    envConfig.feishu,
    env,
    FEISHU_ENABLED_ENV,
  );
  const lineEnabled = shouldEnableSettingsChannel(
    snapshot.messaging.line.enabled.value,
    envConfig.line,
    env,
    LINE_ENABLED_ENV,
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
            authorizedTeamIds: mattermostAuthorizedTeamIds,
            authorizedConversationIds: mattermostAuthorizedConversationIds,
          },
        }
      : {};

  const slackConfig =
    messagingEnabled
    && buildChannelConfig({
      log,
      channel: "slack",
      enabled: slackEnabled,
      hasToken: Boolean(slackBotToken) && Boolean(slackAppToken),
      logStartupEligibility: options.logStartupEligibility === true,
      authorizedActorCount: slackAuthorizedActorIds.length,
    })
      ? {
          slack: {
            channel: "slack" as const,
            enabled: true,
            botToken: slackBotToken!,
            appToken: slackAppToken!,
            ...(slackSigningSecret ? { signingSecret: slackSigningSecret } : {}),
            ...(slackWorkspaceUrl ? { workspaceUrl: slackWorkspaceUrl } : {}),
            inboundMode: slackInboundMode,
            ...(slackSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: slackSlashCommandPrefix }
              : {}),
            registerSlashCommands: slackRegisterSlashCommands,
            streamingResponses: snapshot.messaging.slack.streamingResponses.value,
            authorizedActorIds: slackAuthorizedActorIds,
            authorizedTeamIds: slackAuthorizedTeamIds,
          },
        }
      : {};

  const feishuConfig =
    messagingEnabled
    && buildChannelConfig({
      log,
      channel: "feishu",
      enabled: feishuEnabled,
      hasToken: Boolean(feishuAppId) && Boolean(feishuAppSecret),
      logStartupEligibility: options.logStartupEligibility === true,
      authorizedActorCount: feishuAuthorizedActorIds.length,
    })
    && feishuTenantUrl
    && feishuCallbackBaseUrl
      ? {
          feishu: {
            channel: "feishu" as const,
            enabled: true,
            appId: feishuAppId!,
            appSecret: feishuAppSecret!,
            inboundMode: feishuInboundMode,
            tenantRegion: feishuTenantRegion,
            tenantUrl: feishuTenantUrl,
            callbackBaseUrl: feishuCallbackBaseUrl,
            ...(feishuEncryptKey ? { encryptKey: feishuEncryptKey } : {}),
            ...(feishuVerificationToken
              ? { verificationToken: feishuVerificationToken }
              : {}),
            ...(feishuSlashCommandPrefix !== undefined
              ? { slashCommandPrefix: feishuSlashCommandPrefix }
              : {}),
            registerSlashCommands: feishuRegisterSlashCommands,
            streamingResponses: snapshot.messaging.feishu.streamingResponses.value,
            authorizedActorIds: feishuAuthorizedActorIds,
            authorizedChatIds: feishuAuthorizedChatIds,
            authorizedTenantKeys: feishuAuthorizedTenantKeys,
          },
        }
      : {};

  const lineConfig =
    messagingEnabled
    && buildChannelConfig({
      log,
      channel: "line",
      enabled: lineEnabled,
      hasToken: Boolean(lineChannelSecret),
      logStartupEligibility: options.logStartupEligibility === true,
      authorizedActorCount: lineAuthorizedActorIds.length,
    })
    && lineCallbackBaseUrl
      ? {
          line: {
            channel: "line" as const,
            enabled: true,
            channelSecret: lineChannelSecret!,
            callbackBaseUrl: lineCallbackBaseUrl,
            ...(lineChannelAccessToken
              ? { channelAccessToken: lineChannelAccessToken }
              : {}),
            ...(lineWebhookUrl ? { webhookUrl: lineWebhookUrl } : {}),
            ...(lineBotUserId ? { botUserId: lineBotUserId } : {}),
            streamingResponses: snapshot.messaging.line.streamingResponses.value,
            authorizedActorIds: lineAuthorizedActorIds,
            authorizedGroupIds: lineAuthorizedGroupIds,
            authorizedRoomIds: lineAuthorizedRoomIds,
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
    ...slackConfig,
    ...feishuConfig,
    ...lineConfig,
  };
}

/**
 * Evaluate whether a messaging channel can start, logging the decision clearly.
 * Returns true when the channel is enabled and has credentials. An empty actor
 * allowlist is allowed so first-time setup can receive and audit rejected
 * messages; the controller and adapters still discard every inbound action.
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
      log.warn(
        `${channel}: enabled with no authorized user IDs configured — starting in discovery mode; inbound messages will be discarded and logged in Messaging Activity`,
        { channel },
      );
    }
    return true;
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
          authorizedWorkspaceCount: config.mattermost.authorizedTeamIds?.length ?? 0,
          authorizedConversationCount:
            config.mattermost.authorizedConversationIds?.length ?? 0,
        }
      : undefined,
    slack: config.slack
      ? {
          channel: config.slack.channel,
          enabled: config.slack.enabled !== false,
          botToken: "[REDACTED]",
          appToken: config.slack.appToken ? "[REDACTED]" : undefined,
          signingSecret: config.slack.signingSecret ? "[REDACTED]" : undefined,
          workspaceUrl: config.slack.workspaceUrl,
          inboundMode: config.slack.inboundMode ?? "socket",
          slashCommandPrefix: config.slack.slashCommandPrefix ?? "[default]",
          registerSlashCommands: config.slack.registerSlashCommands ?? false,
          streamingResponses: config.slack.streamingResponses ?? false,
          authorizedActorCount: config.slack.authorizedActorIds.length,
          authorizedWorkspaceCount: config.slack.authorizedTeamIds?.length ?? 0,
        }
      : undefined,
    feishu: config.feishu
      ? {
          channel: config.feishu.channel,
          enabled: config.feishu.enabled !== false,
          appId: "[REDACTED]",
          appSecret: "[REDACTED]",
          encryptKey: config.feishu.encryptKey ? "[REDACTED]" : undefined,
          verificationToken: config.feishu.verificationToken
            ? "[REDACTED]"
            : undefined,
          inboundMode: config.feishu.inboundMode ?? "persistent",
          tenantRegion: config.feishu.tenantRegion ?? "feishu",
          tenantUrl: config.feishu.tenantUrl,
          callbackBaseUrl: config.feishu.callbackBaseUrl,
          slashCommandPrefix: config.feishu.slashCommandPrefix ?? "[default]",
          registerSlashCommands: config.feishu.registerSlashCommands ?? false,
          streamingResponses: config.feishu.streamingResponses ?? false,
          authorizedActorCount: config.feishu.authorizedActorIds.length,
          authorizedChatCount: config.feishu.authorizedChatIds?.length ?? 0,
          authorizedTenantCount: config.feishu.authorizedTenantKeys?.length ?? 0,
        }
      : undefined,
    line: config.line
      ? {
          channel: config.line.channel,
          enabled: config.line.enabled !== false,
          ...(config.line.channelAccessToken
            ? { channelAccessToken: "[REDACTED]" }
            : {}),
          channelSecret: "[REDACTED]",
          callbackBaseUrl: config.line.callbackBaseUrl,
          webhookUrl: config.line.webhookUrl,
          botUserId: config.line.botUserId,
          streamingResponses: config.line.streamingResponses ?? false,
          authorizedActorCount: config.line.authorizedActorIds.length,
          authorizedGroupCount: config.line.authorizedGroupIds?.length ?? 0,
          authorizedRoomCount: config.line.authorizedRoomIds?.length ?? 0,
        }
      : undefined,
    attachmentPolicy: config.attachmentPolicy,
  };
}

function readInputDebounceMsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const value = readEnvInteger(env, MESSAGING_INPUT_DEBOUNCE_MS_ENV).value;
  return value === undefined ? undefined : Math.min(value, 5_000);
}

function authorizationUpdateForChannelConfig(
  config: DesktopMessagingConfig,
  channel: DesktopMessagingConfigChannel,
): MessagingAdapterAuthorizationUpdate {
  switch (channel) {
    case "telegram":
      return {
        authorizedActorIds: contactIds(config.telegram?.authorizedActorIds),
        authorizedConversationIds: contactIds(config.telegram?.authorizedSupergroupIds),
      };
    case "discord":
      return {
        authorizedActorIds: contactIds(config.discord?.authorizedActorIds),
        authorizedConversationIds: contactIds(config.discord?.authorizedGuildIds),
      };
    case "mattermost":
      return {
        authorizedActorIds: contactIds(config.mattermost?.authorizedActorIds),
        authorizedConversationIds: contactIds(
          config.mattermost?.authorizedConversationIds,
        ),
        authorizedWorkspaceIds: contactIds(config.mattermost?.authorizedTeamIds),
      };
    case "slack":
      return {
        authorizedActorIds: contactIds(config.slack?.authorizedActorIds),
        authorizedConversationIds: contactIds(config.slack?.authorizedConversationIds),
        authorizedWorkspaceIds: contactIds(config.slack?.authorizedTeamIds),
      };
    case "feishu":
      return {
        authorizedActorIds: contactIds(config.feishu?.authorizedActorIds),
        authorizedConversationIds: contactIds(config.feishu?.authorizedChatIds),
        authorizedWorkspaceIds: contactIds(config.feishu?.authorizedTenantKeys),
      };
    case "line":
      return {
        authorizedActorIds: contactIds(config.line?.authorizedActorIds),
        authorizedConversationIds: [
          ...contactIds(config.line?.authorizedGroupIds),
          ...contactIds(config.line?.authorizedRoomIds),
        ],
      };
    default: {
      const exhaustive: never = channel;
      throw new Error(`unknown messaging channel: ${exhaustive}`);
    }
  }
}

function renderingPreferencesForChannelConfig(
  config: DesktopMessagingConfig,
  channel: DesktopMessagingConfigChannel,
): MessagingAdapterRenderingPreferencesUpdate {
  switch (channel) {
    case "telegram":
      return { streamingResponses: config.telegram?.streamingResponses };
    case "discord":
      return { streamingResponses: config.discord?.streamingResponses };
    case "mattermost":
      return { streamingResponses: config.mattermost?.streamingResponses };
    case "slack":
      return { streamingResponses: config.slack?.streamingResponses };
    case "feishu":
      return { streamingResponses: config.feishu?.streamingResponses };
    case "line":
      return { streamingResponses: config.line?.streamingResponses };
    default: {
      const exhaustive: never = channel;
      throw new Error(`unknown messaging channel: ${exhaustive}`);
    }
  }
}

function contactIds(
  contacts: readonly { id: string }[] | undefined,
): readonly string[] {
  return contacts?.map((contact) => contact.id) ?? [];
}

function stableMessagingConfigStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableMessagingConfigStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableMessagingConfigStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function readEnv(
  env: NodeJS.ProcessEnv,
  primary: string,
  fallback?: string,
): string | undefined {
  return env[primary]?.trim() || (fallback ? env[fallback]?.trim() : undefined);
}

function readSlackInboundMode(value: string | undefined): "socket" | "events" | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "socket" || normalized === "events" ? normalized : undefined;
}

function readFeishuTenantRegion(value: string | undefined): "feishu" | "lark" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "lark" ? "lark" : "feishu";
}

function readFeishuInboundMode(value: string | undefined): "persistent" | "webhook" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "webhook" ? "webhook" : "persistent";
}

function tenantUrlForFeishuRegion(region: "feishu" | "lark"): string {
  return region === "lark" ? LARK_DEFAULT_TENANT_URL : FEISHU_DEFAULT_TENANT_URL;
}

function normalizeSlackRuntimeInboundMode(
  value: "socket" | "events" | undefined,
  log?: Pick<ReturnType<typeof getMainLogger>, "warn">,
): "socket" {
  if (value === "events") {
    log?.warn("slack Events API inbound mode is not implemented; using Socket Mode", {
      channel: "slack",
      configuredInboundMode: "events",
      runtimeInboundMode: "socket",
    });
  }
  return "socket";
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
