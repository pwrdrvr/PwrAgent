import type {
  DesktopMessagingImageProfile,
  DesktopWorktreeStorageLocation,
} from "@pwragent/shared";
import { isDesktopWorktreeStorageLocation } from "@pwragent/shared";

export const CHAT_REPLY_COMPOSER_ENV =
  "PWRAGENT_EXPERIMENTAL_CHAT_REPLY_COMPOSER";
export const TELEGRAM_ENABLED_ENV = "PWRAGENT_MESSAGING_TELEGRAM_ENABLED";
export const TELEGRAM_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_TELEGRAM_STREAMING_RESPONSES";
export const TELEGRAM_BOT_TOKEN_ENV =
  "PWRAGENT_MESSAGING_TELEGRAM_BOT_TOKEN";
export const TELEGRAM_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS";
export const TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV =
  "PWRAGENT_MESSAGING_TELEGRAM_AUTHORIZED_SUPERGROUPS";
export const DISCORD_ENABLED_ENV = "PWRAGENT_MESSAGING_DISCORD_ENABLED";
export const DISCORD_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_DISCORD_STREAMING_RESPONSES";
export const DISCORD_BOT_TOKEN_ENV = "PWRAGENT_MESSAGING_DISCORD_BOT_TOKEN";
export const DISCORD_APPLICATION_ID_ENV =
  "PWRAGENT_MESSAGING_DISCORD_APPLICATION_ID";
export const DISCORD_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS";
export const DISCORD_AUTHORIZED_GUILDS_ENV =
  "PWRAGENT_MESSAGING_DISCORD_AUTHORIZED_GUILDS";
export const MATTERMOST_ENABLED_ENV = "PWRAGENT_MESSAGING_MATTERMOST_ENABLED";
export const MATTERMOST_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_STREAMING_RESPONSES";
export const MATTERMOST_BOT_TOKEN_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN";
export const MATTERMOST_SERVER_URL_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_SERVER_URL";
export const MATTERMOST_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_USER_IDS";
export const MATTERMOST_AUTHORIZED_TEAMS_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_TEAMS";
export const MATTERMOST_AUTHORIZED_CONVERSATIONS_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_CONVERSATIONS";
export const MATTERMOST_CALLBACK_BASE_URL_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_BASE_URL";
export const MATTERMOST_CALLBACK_HMAC_SECRET_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_HMAC_SECRET";
export const MATTERMOST_SLASH_COMMAND_PREFIX_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_SLASH_COMMAND_PREFIX";
export const MATTERMOST_REGISTER_SLASH_COMMANDS_ENV =
  "PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS";
export const SLACK_ENABLED_ENV = "PWRAGENT_MESSAGING_SLACK_ENABLED";
export const SLACK_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_SLACK_STREAMING_RESPONSES";
export const SLACK_BOT_TOKEN_ENV = "PWRAGENT_MESSAGING_SLACK_BOT_TOKEN";
export const SLACK_APP_TOKEN_ENV = "PWRAGENT_MESSAGING_SLACK_APP_TOKEN";
export const SLACK_SIGNING_SECRET_ENV =
  "PWRAGENT_MESSAGING_SLACK_SIGNING_SECRET";
export const SLACK_WORKSPACE_URL_ENV =
  "PWRAGENT_MESSAGING_SLACK_WORKSPACE_URL";
export const SLACK_INBOUND_MODE_ENV =
  "PWRAGENT_MESSAGING_SLACK_INBOUND_MODE";
export const SLACK_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_SLACK_AUTHORIZED_USER_IDS";
export const SLACK_AUTHORIZED_WORKSPACES_ENV =
  "PWRAGENT_MESSAGING_SLACK_AUTHORIZED_WORKSPACES";
export const SLACK_SLASH_COMMAND_PREFIX_ENV =
  "PWRAGENT_MESSAGING_SLACK_SLASH_COMMAND_PREFIX";
export const SLACK_REGISTER_SLASH_COMMANDS_ENV =
  "PWRAGENT_MESSAGING_SLACK_REGISTER_SLASH_COMMANDS";
export const FEISHU_ENABLED_ENV = "PWRAGENT_MESSAGING_FEISHU_ENABLED";
export const FEISHU_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_FEISHU_STREAMING_RESPONSES";
export const FEISHU_APP_ID_ENV = "PWRAGENT_MESSAGING_FEISHU_APP_ID";
export const FEISHU_APP_SECRET_ENV = "PWRAGENT_MESSAGING_FEISHU_APP_SECRET";
export const FEISHU_ENCRYPT_KEY_ENV = "PWRAGENT_MESSAGING_FEISHU_ENCRYPT_KEY";
export const FEISHU_VERIFICATION_TOKEN_ENV =
  "PWRAGENT_MESSAGING_FEISHU_VERIFICATION_TOKEN";
export const FEISHU_INBOUND_MODE_ENV =
  "PWRAGENT_MESSAGING_FEISHU_INBOUND_MODE";
export const FEISHU_TENANT_REGION_ENV =
  "PWRAGENT_MESSAGING_FEISHU_TENANT_REGION";
export const FEISHU_TENANT_URL_ENV = "PWRAGENT_MESSAGING_FEISHU_TENANT_URL";
export const FEISHU_CALLBACK_BASE_URL_ENV =
  "PWRAGENT_MESSAGING_FEISHU_CALLBACK_BASE_URL";
export const FEISHU_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_USER_IDS";
export const FEISHU_AUTHORIZED_CHATS_ENV =
  "PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_CHATS";
export const FEISHU_AUTHORIZED_TENANTS_ENV =
  "PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_TENANTS";
export const FEISHU_SLASH_COMMAND_PREFIX_ENV =
  "PWRAGENT_MESSAGING_FEISHU_SLASH_COMMAND_PREFIX";
export const FEISHU_REGISTER_SLASH_COMMANDS_ENV =
  "PWRAGENT_MESSAGING_FEISHU_REGISTER_SLASH_COMMANDS";
export const LINE_ENABLED_ENV = "PWRAGENT_MESSAGING_LINE_ENABLED";
export const LINE_STREAMING_RESPONSES_ENV =
  "PWRAGENT_MESSAGING_LINE_STREAMING_RESPONSES";
export const LINE_CHANNEL_ACCESS_TOKEN_ENV =
  "PWRAGENT_MESSAGING_LINE_CHANNEL_ACCESS_TOKEN";
export const LINE_CHANNEL_SECRET_ENV =
  "PWRAGENT_MESSAGING_LINE_CHANNEL_SECRET";
export const LINE_WEBHOOK_URL_ENV =
  "PWRAGENT_MESSAGING_LINE_WEBHOOK_URL";
export const LINE_CALLBACK_BASE_URL_ENV =
  "PWRAGENT_MESSAGING_LINE_CALLBACK_BASE_URL";
export const LINE_BOT_USER_ID_ENV =
  "PWRAGENT_MESSAGING_LINE_BOT_USER_ID";
export const LINE_AUTHORIZED_USER_IDS_ENV =
  "PWRAGENT_MESSAGING_LINE_AUTHORIZED_USER_IDS";
export const LINE_AUTHORIZED_GROUPS_ENV =
  "PWRAGENT_MESSAGING_LINE_AUTHORIZED_GROUPS";
export const LINE_AUTHORIZED_ROOMS_ENV =
  "PWRAGENT_MESSAGING_LINE_AUTHORIZED_ROOMS";
export const MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV =
  "PWRAGENT_MESSAGING_ATTACHMENT_IMAGE_PROFILE";
export const MESSAGING_ATTACHMENT_MAX_BYTES_ENV =
  "PWRAGENT_MESSAGING_ATTACHMENT_MAX_BYTES";
export const MESSAGING_ATTACHMENT_MAX_COUNT_ENV =
  "PWRAGENT_MESSAGING_ATTACHMENT_MAX_COUNT";
export const MESSAGING_INPUT_DEBOUNCE_MS_ENV =
  "PWRAGENT_MESSAGING_INPUT_DEBOUNCE_MS";
export const CODEX_COMMAND_ENV = "PWRAGENT_CODEX_COMMAND";
export const GH_COMMAND_ENV = "PWRAGENT_GH_COMMAND";
export const WORKTREE_STORAGE_ENV = "PWRAGENT_WORKTREE_STORAGE";

export type ParsedEnvValue<T> = {
  value?: T;
  error?: string;
};

export function readEnvString(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  return env[key]?.trim() || undefined;
}

export function readEnvBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
): ParsedEnvValue<boolean> {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return {};
  }

  const value = rawValue.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(value)) {
    return { value: true };
  }
  if (["false", "0", "no", "off"].includes(value)) {
    return { value: false };
  }

  return { error: `Invalid boolean value for ${key}` };
}

export function readEnvList(
  env: NodeJS.ProcessEnv,
  key: string,
): string[] | undefined {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return undefined;
  }

  return rawValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function readEnvInteger(
  env: NodeJS.ProcessEnv,
  key: string,
): ParsedEnvValue<number> {
  const rawValue = env[key];
  if (rawValue === undefined) {
    return {};
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {};
  }
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 0
    ? { value }
    : { error: `Invalid integer value for ${key}` };
}

export function readEnvMessagingImageProfile(
  env: NodeJS.ProcessEnv,
): ParsedEnvValue<DesktopMessagingImageProfile> {
  const value = readEnvString(env, MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV);
  if (!value) {
    return {};
  }
  if (!isDesktopMessagingImageProfile(value)) {
    return {
      error: `Invalid image profile for ${MESSAGING_ATTACHMENT_IMAGE_PROFILE_ENV}`,
    };
  }
  return { value };
}

export function readEnvWorktreeStorage(
  env: NodeJS.ProcessEnv,
): ParsedEnvValue<DesktopWorktreeStorageLocation> {
  const value = readEnvString(env, WORKTREE_STORAGE_ENV);
  if (!value) {
    return {};
  }
  if (!isDesktopWorktreeStorageLocation(value)) {
    return {
      error: `Invalid worktree storage value for ${WORKTREE_STORAGE_ENV}`,
    };
  }
  return { value };
}

function isDesktopMessagingImageProfile(
  value: string,
): value is DesktopMessagingImageProfile {
  return value === "low" || value === "medium" || value === "high" || value === "actual";
}
