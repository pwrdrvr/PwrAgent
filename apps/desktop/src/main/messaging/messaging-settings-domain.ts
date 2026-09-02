import type {
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragent/shared";
import {
  SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT,
  SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT,
  SLACK_DM_ACCESS_MODE_DEFAULT,
  SLACK_GROUP_DM_ACCESS_MODE_DEFAULT,
  SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT,
} from "@pwragent/messaging-interface";
import type { ConfigDomainMap } from "../settings/config-store/config-domains";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  FEISHU_CALLBACK_BASE_URL_ENV,
  FEISHU_AUTHORIZED_CHATS_ENV,
  FEISHU_AUTHORIZED_TENANTS_ENV,
  FEISHU_AUTHORIZED_USER_IDS_ENV,
  FEISHU_ENABLED_ENV,
  FEISHU_INBOUND_MODE_ENV,
  FEISHU_REGISTER_SLASH_COMMANDS_ENV,
  FEISHU_SLASH_COMMAND_PREFIX_ENV,
  FEISHU_STREAMING_RESPONSES_ENV,
  FEISHU_TENANT_REGION_ENV,
  FEISHU_TENANT_URL_ENV,
  LINE_BOT_USER_ID_ENV,
  LINE_AUTHORIZED_GROUPS_ENV,
  LINE_AUTHORIZED_ROOMS_ENV,
  LINE_AUTHORIZED_USER_IDS_ENV,
  LINE_CALLBACK_BASE_URL_ENV,
  LINE_ENABLED_ENV,
  LINE_STREAMING_RESPONSES_ENV,
  LINE_WEBHOOK_URL_ENV,
  MATTERMOST_CALLBACK_BASE_URL_ENV,
  MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
  MATTERMOST_AUTHORIZED_TEAMS_ENV,
  MATTERMOST_AUTHORIZED_USER_IDS_ENV,
  MATTERMOST_ENABLED_ENV,
  MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
  MATTERMOST_SERVER_URL_ENV,
  MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
  MATTERMOST_STREAMING_RESPONSES_ENV,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  SLACK_ENABLED_ENV,
  SLACK_AUTHORIZED_USER_IDS_ENV,
  SLACK_AUTHORIZED_WORKSPACES_ENV,
  SLACK_INBOUND_MODE_ENV,
  SLACK_REGISTER_SLASH_COMMANDS_ENV,
  SLACK_SLASH_COMMAND_PREFIX_ENV,
  SLACK_STREAMING_RESPONSES_ENV,
  SLACK_WORKSPACE_URL_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
  readEnvBoolean,
  readEnvInteger,
  readEnvList,
  readEnvMessagingImageProfile,
  readEnvMessagingPdfProfile,
  readEnvString,
} from "../settings/desktop-settings-env";

const LINE_DEFAULT_CALLBACK_BASE_URL = "http://127.0.0.1:47822";
const FEISHU_DEFAULT_CALLBACK_BASE_URL = "http://127.0.0.1:47823";
const FEISHU_DEFAULT_TENANT_URL = "https://open.feishu.cn";
const LARK_DEFAULT_TENANT_URL = "https://open.larksuite.com";

export function resolveMessagingSettingsDomain(
  config: ConfigDomainMap["messaging"],
  env: NodeJS.ProcessEnv,
): DesktopSettingsSnapshot["messaging"] {
  const feishuTenantRegion = envEnumSetting(
    config.feishu?.tenantRegion,
    "feishu",
    env,
    FEISHU_TENANT_REGION_ENV,
    ["feishu", "lark"] as const,
  );
  return {
    enabled: setting(config.enabled, true),
    allowFullAccessEscalation: setting(
      config.allowFullAccessEscalation,
      true,
    ),
    allowFullAccessThreadResume: setting(
      config.allowFullAccessThreadResume,
      true,
    ),
    fullAccessWarning: setting(config.fullAccessWarning, "dismissable"),
    inputDebounceMs: clampedIntegerSetting(
      config.inputDebounceMs,
      500,
      env,
      MESSAGING_INPUT_DEBOUNCE_MS_ENV,
      5_000,
    ),
    toolUpdateMode: setting(config.toolUpdateMode, "show_some"),
    managerToolUpdateMode: setting(
      config.managerToolUpdateMode,
      "show_none",
    ),
    showStreamingOption: setting(config.showStreamingOption, false),
    attachments: {
      imageProfile: parsedEnvSetting(
        config.attachments?.imageProfile,
        "medium",
        readEnvMessagingImageProfile(env).value,
      ),
      pdfProfile: parsedEnvSetting(
        config.attachments?.pdfProfile,
        "high",
        readEnvMessagingPdfProfile(env).value,
      ),
      maxAttachmentBytes: integerSetting(
        config.attachments?.maxAttachmentBytes,
        10 * 1024 * 1024,
        env,
        MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
      ),
      maxAttachmentCount: integerSetting(
        config.attachments?.maxAttachmentCount,
        4,
        env,
        MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
      ),
    },
    telegram: {
      enabled: booleanSetting(
        config.telegram?.enabled,
        false,
        env,
        TELEGRAM_ENABLED_ENV,
      ),
      responseMode: setting(config.telegram?.responseMode, "every_message"),
      streamingResponses: booleanSetting(
        config.telegram?.streamingResponses,
        false,
        env,
        TELEGRAM_STREAMING_RESPONSES_ENV,
      ),
      botToken: unreadSecretState(),
      authorizedUserIds: contactListSetting(
        config.telegram?.authorizedUserIds,
        env,
        TELEGRAM_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedSupergroups: contactListSetting(
        config.telegram?.authorizedSupergroups,
        env,
        TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
      ),
    },
    discord: {
      enabled: booleanSetting(
        config.discord?.enabled,
        false,
        env,
        DISCORD_ENABLED_ENV,
      ),
      responseMode: setting(config.discord?.responseMode, "every_message"),
      responseModeOverrides: setting(
        config.discord?.responseModeOverrides,
        [],
      ),
      streamingResponses: booleanSetting(
        config.discord?.streamingResponses,
        false,
        env,
        DISCORD_STREAMING_RESPONSES_ENV,
      ),
      botToken: unreadSecretState(),
      applicationId: stringSetting(
        config.discord?.applicationId,
        env,
        DISCORD_APPLICATION_ID_ENV,
      ),
      authorizedUserIds: contactListSetting(
        config.discord?.authorizedUserIds,
        env,
        DISCORD_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedGuilds: contactListSetting(
        config.discord?.authorizedGuilds,
        env,
        DISCORD_AUTHORIZED_GUILDS_ENV,
      ),
    },
    mattermost: {
      enabled: booleanSetting(
        config.mattermost?.enabled,
        false,
        env,
        MATTERMOST_ENABLED_ENV,
      ),
      streamingResponses: booleanSetting(
        config.mattermost?.streamingResponses,
        false,
        env,
        MATTERMOST_STREAMING_RESPONSES_ENV,
      ),
      botToken: unreadSecretState(),
      hmacSecret: unreadSecretState(),
      serverUrl: stringSetting(
        config.mattermost?.serverUrl,
        env,
        MATTERMOST_SERVER_URL_ENV,
      ),
      callbackBaseUrl: stringSetting(
        config.mattermost?.callbackBaseUrl,
        env,
        MATTERMOST_CALLBACK_BASE_URL_ENV,
      ),
      slashCommandPrefix: stringSetting(
        config.mattermost?.slashCommandPrefix,
        env,
        MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
        "pwragent_",
      ),
      registerSlashCommands: booleanSetting(
        config.mattermost?.registerSlashCommands,
        false,
        env,
        MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
      ),
      authorizedUserIds: contactListSetting(
        config.mattermost?.authorizedUserIds,
        env,
        MATTERMOST_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedTeams: contactListSetting(
        config.mattermost?.authorizedTeams,
        env,
        MATTERMOST_AUTHORIZED_TEAMS_ENV,
      ),
      authorizedConversations: contactListSetting(
        config.mattermost?.authorizedConversations,
        env,
        MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV,
      ),
    },
    slack: {
      enabled: booleanSetting(
        config.slack?.enabled,
        false,
        env,
        SLACK_ENABLED_ENV,
      ),
      liveWorkingCards: setting(config.slack?.liveWorkingCards, false),
      responseMode: setting(config.slack?.responseMode, "mention_only"),
      streamingResponses: booleanSetting(
        config.slack?.streamingResponses,
        false,
        env,
        SLACK_STREAMING_RESPONSES_ENV,
      ),
      botToken: unreadSecretState(),
      appToken: unreadSecretState(),
      signingSecret: unreadSecretState(),
      workspaceUrl: stringSetting(
        config.slack?.workspaceUrl,
        env,
        SLACK_WORKSPACE_URL_ENV,
      ),
      inboundMode: envEnumSetting(
        config.slack?.inboundMode,
        "socket",
        env,
        SLACK_INBOUND_MODE_ENV,
        ["socket", "events"] as const,
      ),
      teamAuthorizationMode: setting(
        config.slack?.teamAuthorizationMode,
        SLACK_TEAM_AUTHORIZATION_MODE_DEFAULT,
      ),
      channelAuthorizationMode: setting(
        config.slack?.channelAuthorizationMode,
        SLACK_CHANNEL_AUTHORIZATION_MODE_DEFAULT,
      ),
      dmAccessMode: setting(
        config.slack?.dmAccessMode,
        SLACK_DM_ACCESS_MODE_DEFAULT,
      ),
      groupDmAccessMode: setting(
        config.slack?.groupDmAccessMode,
        SLACK_GROUP_DM_ACCESS_MODE_DEFAULT,
      ),
      channelUserAccessMode: setting(
        config.slack?.channelUserAccessMode,
        SLACK_CHANNEL_USER_ACCESS_MODE_DEFAULT,
      ),
      slashCommandPrefix: stringSetting(
        config.slack?.slashCommandPrefix,
        env,
        SLACK_SLASH_COMMAND_PREFIX_ENV,
        "pwragent_",
      ),
      registerSlashCommands: booleanSetting(
        config.slack?.registerSlashCommands,
        false,
        env,
        SLACK_REGISTER_SLASH_COMMANDS_ENV,
      ),
      authorizedUserIds: contactListSetting(
        config.slack?.authorizedUserIds,
        env,
        SLACK_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedWorkspaces: contactListSetting(
        config.slack?.authorizedWorkspaces,
        env,
        SLACK_AUTHORIZED_WORKSPACES_ENV,
      ),
      authorizedChannels: setting(config.slack?.authorizedChannels, []),
    },
    feishu: {
      enabled: booleanSetting(
        config.feishu?.enabled,
        false,
        env,
        FEISHU_ENABLED_ENV,
      ),
      streamingResponses: booleanSetting(
        config.feishu?.streamingResponses,
        false,
        env,
        FEISHU_STREAMING_RESPONSES_ENV,
      ),
      appId: unreadSecretState(),
      appSecret: unreadSecretState(),
      encryptKey: unreadSecretState(),
      verificationToken: unreadSecretState(),
      inboundMode: envEnumSetting(
        config.feishu?.inboundMode,
        "persistent",
        env,
        FEISHU_INBOUND_MODE_ENV,
        ["persistent", "webhook"] as const,
      ),
      tenantRegion: feishuTenantRegion,
      tenantUrl: stringSetting(
        config.feishu?.tenantUrl,
        env,
        FEISHU_TENANT_URL_ENV,
        feishuTenantRegion.value === "lark"
          ? LARK_DEFAULT_TENANT_URL
          : FEISHU_DEFAULT_TENANT_URL,
      ),
      callbackBaseUrl: stringSetting(
        config.feishu?.callbackBaseUrl,
        env,
        FEISHU_CALLBACK_BASE_URL_ENV,
        FEISHU_DEFAULT_CALLBACK_BASE_URL,
      ),
      slashCommandPrefix: stringSetting(
        config.feishu?.slashCommandPrefix,
        env,
        FEISHU_SLASH_COMMAND_PREFIX_ENV,
        "pwragent_",
      ),
      registerSlashCommands: booleanSetting(
        config.feishu?.registerSlashCommands,
        false,
        env,
        FEISHU_REGISTER_SLASH_COMMANDS_ENV,
      ),
      authorizedUserIds: contactListSetting(
        config.feishu?.authorizedUserIds,
        env,
        FEISHU_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedChats: contactListSetting(
        config.feishu?.authorizedChats,
        env,
        FEISHU_AUTHORIZED_CHATS_ENV,
      ),
      authorizedTenants: contactListSetting(
        config.feishu?.authorizedTenants,
        env,
        FEISHU_AUTHORIZED_TENANTS_ENV,
      ),
    },
    line: {
      enabled: booleanSetting(
        config.line?.enabled,
        false,
        env,
        LINE_ENABLED_ENV,
      ),
      streamingResponses: booleanSetting(
        config.line?.streamingResponses,
        false,
        env,
        LINE_STREAMING_RESPONSES_ENV,
      ),
      channelAccessToken: unreadSecretState(),
      channelSecret: unreadSecretState(),
      webhookUrl: stringSetting(
        config.line?.webhookUrl,
        env,
        LINE_WEBHOOK_URL_ENV,
      ),
      callbackBaseUrl: stringSetting(
        config.line?.callbackBaseUrl,
        env,
        LINE_CALLBACK_BASE_URL_ENV,
        LINE_DEFAULT_CALLBACK_BASE_URL,
      ),
      botUserId: stringSetting(
        config.line?.botUserId,
        env,
        LINE_BOT_USER_ID_ENV,
      ),
      authorizedUserIds: contactListSetting(
        config.line?.authorizedUserIds,
        env,
        LINE_AUTHORIZED_USER_IDS_ENV,
      ),
      authorizedGroups: contactListSetting(
        config.line?.authorizedGroups,
        env,
        LINE_AUTHORIZED_GROUPS_ENV,
      ),
      authorizedRooms: contactListSetting(
        config.line?.authorizedRooms,
        env,
        LINE_AUTHORIZED_ROOMS_ENV,
      ),
    },
  };
}

function setting<T>(
  configured: T | undefined,
  defaultValue: T,
): DesktopSettingsValue<T> {
  return {
    value: configured ?? defaultValue,
    source: configured === undefined ? "default" : "config",
  };
}

function parsedEnvSetting<T>(
  configured: T | undefined,
  defaultValue: T,
  envValue: T | undefined,
): DesktopSettingsValue<T> {
  return envValue === undefined
    ? setting(configured, defaultValue)
    : {
        value: envValue,
        source: "env",
        overriddenByEnv: configured !== undefined,
      };
}

function booleanSetting(
  configured: boolean | undefined,
  defaultValue: boolean,
  env: NodeJS.ProcessEnv,
  envKey: string,
): DesktopSettingsValue<boolean> {
  return parsedEnvSetting(
    configured,
    defaultValue,
    readEnvBoolean(env, envKey).value,
  );
}

function integerSetting(
  configured: number | undefined,
  defaultValue: number,
  env: NodeJS.ProcessEnv,
  envKey: string,
): DesktopSettingsValue<number> {
  return parsedEnvSetting(
    configured,
    defaultValue,
    readEnvInteger(env, envKey).value,
  );
}

function clampedIntegerSetting(
  configured: number | undefined,
  defaultValue: number,
  env: NodeJS.ProcessEnv,
  envKey: string,
  maximum: number,
): DesktopSettingsValue<number> {
  const resolved = integerSetting(configured, defaultValue, env, envKey);
  return {
    ...resolved,
    value: Math.min(Math.max(resolved.value, 0), maximum),
  };
}

function stringSetting(
  configured: string | undefined,
  env: NodeJS.ProcessEnv,
  envKey: string,
  defaultValue = "",
): DesktopSettingsValue<string> {
  return parsedEnvSetting(
    configured,
    defaultValue,
    readEnvString(env, envKey),
  );
}

function envEnumSetting<T extends string>(
  configured: T | undefined,
  defaultValue: T,
  env: NodeJS.ProcessEnv,
  envKey: string,
  allowed: readonly T[],
): DesktopSettingsValue<T> {
  const value = readEnvString(env, envKey);
  return parsedEnvSetting(
    configured,
    defaultValue,
    value && allowed.includes(value as T) ? value as T : undefined,
  );
}

function contactListSetting(
  configured: DesktopSettingsSnapshot["messaging"]["telegram"]["authorizedUserIds"]["value"]
    | undefined,
  env: NodeJS.ProcessEnv,
  envKey: string,
) {
  const envValue = readEnvList(env, envKey)?.map((id) => ({
    id,
    displayName: "",
  }));
  return parsedEnvSetting(configured, [], envValue);
}

function unreadSecretState() {
  return {
    configured: false,
    source: "unset" as const,
    writable: false,
  };
}
