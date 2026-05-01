import type { DesktopChatReplyComposer } from "@pwragnt/shared";

export const DESKTOP_CONFIG_PATH_ENV = "PWRAGNT_CONFIG_PATH";
export const CHAT_REPLY_COMPOSER_ENV =
  "PWRAGNT_EXPERIMENTAL_CHAT_REPLY_COMPOSER";
export const TELEGRAM_ENABLED_ENV = "PWRAGNT_MESSAGING_TELEGRAM_ENABLED";
export const TELEGRAM_BOT_TOKEN_ENV =
  "PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN";
export const TELEGRAM_AUTHORIZED_USER_IDS_ENV =
  "PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS";
export const TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV =
  "PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_SUPERGROUPS";
export const DISCORD_ENABLED_ENV = "PWRAGNT_MESSAGING_DISCORD_ENABLED";
export const DISCORD_BOT_TOKEN_ENV = "PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN";
export const DISCORD_APPLICATION_ID_ENV =
  "PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID";
export const DISCORD_AUTHORIZED_USER_IDS_ENV =
  "PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS";
export const DISCORD_AUTHORIZED_GUILDS_ENV =
  "PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_GUILDS";
export const CODEX_COMMAND_ENV = "PWRAGNT_CODEX_COMMAND";

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

export function readEnvComposer(
  env: NodeJS.ProcessEnv,
): ParsedEnvValue<DesktopChatReplyComposer> {
  const value = readEnvString(env, CHAT_REPLY_COMPOSER_ENV);
  if (!value) {
    return {};
  }
  if (!isDesktopChatReplyComposer(value)) {
    return { error: `Invalid composer value for ${CHAT_REPLY_COMPOSER_ENV}` };
  }
  return { value };
}

function isDesktopChatReplyComposer(
  value: string,
): value is DesktopChatReplyComposer {
  return (
    value === "textarea"
    || value === "tiptap-chips"
    || value === "tiptap-wysiwyg-markdown-chips"
    || value === "custom-widget-chips"
  );
}
