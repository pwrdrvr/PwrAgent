import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DesktopChatReplyComposer,
  DesktopMessagingImageProfile,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragnt/shared";
import { isDesktopWorktreeStorageLocation } from "@pwragnt/shared";
import { DESKTOP_CONFIG_PATH_ENV } from "./desktop-settings-env";

type DesktopConfigPathOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  xdgConfigHome?: string;
};

export type DesktopSettingsConfig = {
  experimental?: {
    chatReplyComposer?: DesktopChatReplyComposer;
  };
  messaging?: {
    inputDebounceMs?: number;
    toolUpdateMode?: MessagingToolUpdateMode;
    attachments?: {
      imageProfile?: DesktopMessagingImageProfile;
      maxAttachmentBytes?: number;
      maxAttachmentCount?: number;
    };
    telegram?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      authorizedUserIds?: string[];
      authorizedSupergroups?: string[];
    };
    discord?: {
      enabled?: boolean;
      streamingResponses?: boolean;
      applicationId?: string;
      authorizedUserIds?: string[];
      authorizedGuilds?: string[];
    };
  };
  models?: {
    codex?: {
      path?: string;
    };
  };
  applications?: {
    editor?: {
      preferredId?: string;
    };
    terminal?: {
      preferredId?: string;
    };
  };
  worktrees?: {
    storage?: DesktopWorktreeStorageLocation;
  };
};

type TomlScalar = string | number | boolean | string[];

export function defaultDesktopConfigDir(
  options?: DesktopConfigPathOptions,
): string {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const xdgConfigHome =
    options?.xdgConfigHome?.trim() || env.XDG_CONFIG_HOME?.trim();

  return path.join(xdgConfigHome || path.join(homeDir, ".config"), "pwragnt");
}

export function userHomeWorktreesRoot(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".pwragnt", "worktrees");
}

export function resolveDesktopConfigPath(
  options?: DesktopConfigPathOptions,
): string {
  const env = options?.env ?? process.env;
  return (
    env[DESKTOP_CONFIG_PATH_ENV]?.trim()
    || path.join(defaultDesktopConfigDir(options), "config.toml")
  );
}

export function readDesktopSettingsConfig(
  configPath: string,
): DesktopSettingsConfig {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  return parseDesktopSettingsToml(fs.readFileSync(configPath, "utf8"), configPath);
}

export function writeDesktopSettingsConfig(
  configPath: string,
  config: DesktopSettingsConfig,
): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, stringifyDesktopSettingsToml(config), "utf8");
  fs.renameSync(temporaryPath, configPath);
}

export function mergeDesktopSettingsConfig(
  current: DesktopSettingsConfig,
  patch: DesktopSettingsConfig,
): DesktopSettingsConfig {
  return pruneEmptyConfig({
    experimental: {
      ...current.experimental,
      ...patch.experimental,
    },
    messaging: {
      inputDebounceMs:
        patch.messaging?.inputDebounceMs ?? current.messaging?.inputDebounceMs,
      toolUpdateMode:
        patch.messaging?.toolUpdateMode ?? current.messaging?.toolUpdateMode,
      attachments: {
        ...current.messaging?.attachments,
        ...patch.messaging?.attachments,
      },
      telegram: {
        ...current.messaging?.telegram,
        ...patch.messaging?.telegram,
      },
      discord: {
        ...current.messaging?.discord,
        ...patch.messaging?.discord,
      },
    },
    models: {
      codex: {
        ...current.models?.codex,
        ...patch.models?.codex,
      },
    },
    applications: {
      editor: {
        ...current.applications?.editor,
        ...patch.applications?.editor,
      },
      terminal: {
        ...current.applications?.terminal,
        ...patch.applications?.terminal,
      },
    },
    worktrees: {
      ...current.worktrees,
      ...patch.worktrees,
    },
  });
}

export function parseDesktopSettingsToml(
  contents: string,
  filePath: string,
): DesktopSettingsConfig {
  const tables: Record<string, Record<string, TomlScalar>> = {};
  let currentTable = "";

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = stripInlineComment(rawLine).trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("[") && line.endsWith("]")) {
      currentTable = line.slice(1, -1).trim();
      if (!currentTable) {
        throw new Error(`Invalid TOML table on line ${index + 1} in ${filePath}`);
      }
      tables[currentTable] ??= {};
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) {
      throw new Error(`Invalid TOML line ${index + 1} in ${filePath}`);
    }

    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (!key) {
      throw new Error(`Invalid TOML key on line ${index + 1} in ${filePath}`);
    }

    tables[currentTable] ??= {};
    tables[currentTable][key] = parseTomlValue(rawValue, filePath, index + 1);
  }

  return normalizeDesktopConfig(tables);
}

export function stringifyDesktopSettingsToml(
  config: DesktopSettingsConfig,
): string {
  const sections: string[] = [];

  if (config.experimental?.chatReplyComposer) {
    sections.push(
      [
        "[experimental]",
        `chat_reply_composer = ${formatTomlValue(
          config.experimental.chatReplyComposer,
        )}`,
      ].join("\n"),
    );
  }

  if (
    config.messaging?.toolUpdateMode
    || config.messaging?.inputDebounceMs !== undefined
  ) {
    sections.push(
      [
        "[messaging]",
        formatOptionalTomlEntry(
          "input_debounce_ms",
          config.messaging.inputDebounceMs,
        ),
        formatOptionalTomlEntry("tool_update_mode", config.messaging.toolUpdateMode),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const attachments = config.messaging?.attachments;
  if (attachments && hasDefinedValue(attachments)) {
    sections.push(
      [
        "[messaging.attachments]",
        formatOptionalTomlEntry("image_profile", attachments.imageProfile),
        formatOptionalTomlEntry("max_attachment_bytes", attachments.maxAttachmentBytes),
        formatOptionalTomlEntry("max_attachment_count", attachments.maxAttachmentCount),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const telegram = config.messaging?.telegram;
  if (telegram && hasDefinedValue(telegram)) {
    sections.push(
      [
        "[messaging.telegram]",
        formatOptionalTomlEntry("enabled", telegram.enabled),
        formatOptionalTomlEntry(
          "streaming_responses",
          telegram.streamingResponses,
        ),
        formatOptionalTomlEntry(
          "authorized_user_ids",
          telegram.authorizedUserIds,
        ),
        formatOptionalTomlEntry(
          "authorized_supergroups",
          telegram.authorizedSupergroups,
        ),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const discord = config.messaging?.discord;
  if (discord && hasDefinedValue(discord)) {
    sections.push(
      [
        "[messaging.discord]",
        formatOptionalTomlEntry("enabled", discord.enabled),
        formatOptionalTomlEntry(
          "streaming_responses",
          discord.streamingResponses,
        ),
        formatOptionalTomlEntry("application_id", discord.applicationId),
        formatOptionalTomlEntry(
          "authorized_user_ids",
          discord.authorizedUserIds,
        ),
        formatOptionalTomlEntry("authorized_guilds", discord.authorizedGuilds),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  const codex = config.models?.codex;
  if (codex?.path !== undefined) {
    sections.push(
      ["[models.codex]", `path = ${formatTomlValue(codex.path)}`].join("\n"),
    );
  }

  const editor = config.applications?.editor;
  if (editor?.preferredId !== undefined) {
    sections.push(
      [
        "[applications.editor]",
        `preferred_id = ${formatTomlValue(editor.preferredId)}`,
      ].join("\n"),
    );
  }

  const terminal = config.applications?.terminal;
  if (terminal?.preferredId !== undefined) {
    sections.push(
      [
        "[applications.terminal]",
        `preferred_id = ${formatTomlValue(terminal.preferredId)}`,
      ].join("\n"),
    );
  }

  const worktrees = config.worktrees;
  if (worktrees?.storage !== undefined) {
    sections.push(
      ["[worktrees]", `storage = ${formatTomlValue(worktrees.storage)}`].join(
        "\n",
      ),
    );
  }

  return sections.join("\n\n").concat(sections.length ? "\n" : "");
}

function normalizeDesktopConfig(
  tables: Record<string, Record<string, TomlScalar>>,
): DesktopSettingsConfig {
  const experimental = tables["experimental"];
  const messaging = tables["messaging"];
  const attachments = tables["messaging.attachments"];
  const telegram = tables["messaging.telegram"];
  const discord = tables["messaging.discord"];
  const codex = tables["models.codex"];
  const editor = tables["applications.editor"];
  const terminal = tables["applications.terminal"];
  const worktrees = tables["worktrees"];

  return pruneEmptyConfig({
    experimental: {
      chatReplyComposer: readComposer(experimental?.chat_reply_composer),
    },
    messaging: {
      inputDebounceMs: readNumber(messaging?.input_debounce_ms),
      toolUpdateMode: readToolUpdateMode(messaging?.tool_update_mode),
      attachments: {
        imageProfile: readImageProfile(attachments?.image_profile),
        maxAttachmentBytes: readNumber(attachments?.max_attachment_bytes),
        maxAttachmentCount: readNumber(attachments?.max_attachment_count),
      },
      telegram: {
        enabled: readBoolean(telegram?.enabled),
        streamingResponses: readBoolean(telegram?.streaming_responses),
        authorizedUserIds: readStringArray(telegram?.authorized_user_ids),
        authorizedSupergroups: readStringArray(telegram?.authorized_supergroups),
      },
      discord: {
        enabled: readBoolean(discord?.enabled),
        streamingResponses: readBoolean(discord?.streaming_responses),
        applicationId: readString(discord?.application_id),
        authorizedUserIds: readStringArray(discord?.authorized_user_ids),
        authorizedGuilds: readStringArray(discord?.authorized_guilds),
      },
    },
    models: {
      codex: {
        path: readString(codex?.path),
      },
    },
    applications: {
      editor: {
        preferredId: readString(editor?.preferred_id),
      },
      terminal: {
        preferredId: readString(terminal?.preferred_id),
      },
    },
    worktrees: {
      storage: readWorktreeStorage(worktrees?.storage),
    },
  });
}

function pruneEmptyConfig(config: DesktopSettingsConfig): DesktopSettingsConfig {
  const pruned: DesktopSettingsConfig = {};

  if (config.experimental && hasDefinedValue(config.experimental)) {
    pruned.experimental = config.experimental;
  }

  const attachments = config.messaging?.attachments;
  const telegram = config.messaging?.telegram;
  const discord = config.messaging?.discord;
  const inputDebounceMs = config.messaging?.inputDebounceMs;
  const toolUpdateMode = config.messaging?.toolUpdateMode;
  if (
    inputDebounceMs !== undefined ||
    toolUpdateMode !== undefined ||
    (attachments && hasDefinedValue(attachments))
    || (telegram && hasDefinedValue(telegram))
    || (discord && hasDefinedValue(discord))
  ) {
    pruned.messaging = {};
    if (inputDebounceMs !== undefined) {
      pruned.messaging.inputDebounceMs = inputDebounceMs;
    }
    if (toolUpdateMode !== undefined) {
      pruned.messaging.toolUpdateMode = toolUpdateMode;
    }
    if (attachments && hasDefinedValue(attachments)) {
      pruned.messaging.attachments = attachments;
    }
    if (telegram && hasDefinedValue(telegram)) {
      pruned.messaging.telegram = telegram;
    }
    if (discord && hasDefinedValue(discord)) {
      pruned.messaging.discord = discord;
    }
  }

  const codex = config.models?.codex;
  if (codex && hasDefinedValue(codex)) {
    pruned.models = { codex };
  }

  const editor = config.applications?.editor;
  const terminal = config.applications?.terminal;
  if (
    (editor && hasDefinedValue(editor))
    || (terminal && hasDefinedValue(terminal))
  ) {
    pruned.applications = {};
    if (editor && hasDefinedValue(editor)) {
      pruned.applications.editor = editor;
    }
    if (terminal && hasDefinedValue(terminal)) {
      pruned.applications.terminal = terminal;
    }
  }

  const worktrees = config.worktrees;
  if (worktrees && hasDefinedValue(worktrees)) {
    pruned.worktrees = worktrees;
  }

  return pruned;
}

function hasDefinedValue(values: object): boolean {
  return Object.values(values).some((value) => value !== undefined);
}

function readComposer(value: TomlScalar | undefined): DesktopChatReplyComposer | undefined {
  return typeof value === "string" && isDesktopChatReplyComposer(value)
    ? value
    : undefined;
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

function readToolUpdateMode(
  value: TomlScalar | undefined,
): MessagingToolUpdateMode | undefined {
  return typeof value === "string" && isMessagingToolUpdateMode(value)
    ? value
    : undefined;
}

function isMessagingToolUpdateMode(
  value: string,
): value is MessagingToolUpdateMode {
  return (
    value === "show_none"
    || value === "show_less"
    || value === "show_some"
    || value === "show_more"
    || value === "show_all"
  );
}

function readBoolean(value: TomlScalar | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readString(value: TomlScalar | undefined): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function readStringArray(value: TomlScalar | undefined): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => item.trim()).filter(Boolean) : undefined;
}

function readNumber(value: TomlScalar | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readImageProfile(
  value: TomlScalar | undefined,
): DesktopMessagingImageProfile | undefined {
  return typeof value === "string" && isDesktopMessagingImageProfile(value)
    ? value
    : undefined;
}

function isDesktopMessagingImageProfile(
  value: string,
): value is DesktopMessagingImageProfile {
  return value === "low" || value === "medium" || value === "high" || value === "actual";
}

function readWorktreeStorage(
  value: TomlScalar | undefined,
): DesktopWorktreeStorageLocation | undefined {
  return typeof value === "string" && isDesktopWorktreeStorageLocation(value)
    ? value
    : undefined;
}

function parseTomlValue(
  value: string,
  filePath: string,
  lineNumber: number,
): TomlScalar {
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return parseStringArray(value, filePath, lineNumber);
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return unescapeQuotedString(value.slice(1, -1), filePath, lineNumber);
  }
  if (/^-?\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error(`Unsupported TOML value on line ${lineNumber} in ${filePath}`);
}

function parseStringArray(
  value: string,
  filePath: string,
  lineNumber: number,
): string[] {
  const inner = value.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const values: string[] = [];
  let current = "";
  let inQuotedString = false;
  let escaped = false;

  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index];
    if (escaped) {
      current += `\\${character}`;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = inQuotedString;
      if (!inQuotedString) {
        throw new Error(`Invalid TOML array on line ${lineNumber} in ${filePath}`);
      }
      continue;
    }
    if (character === "\"") {
      inQuotedString = !inQuotedString;
      current += character;
      continue;
    }
    if (character === "," && !inQuotedString) {
      values.push(parseStringArrayItem(current.trim(), filePath, lineNumber));
      current = "";
      continue;
    }
    current += character;
  }

  if (inQuotedString) {
    throw new Error(`Unterminated TOML string on line ${lineNumber} in ${filePath}`);
  }

  values.push(parseStringArrayItem(current.trim(), filePath, lineNumber));
  return values;
}

function parseStringArrayItem(
  value: string,
  filePath: string,
  lineNumber: number,
): string {
  const parsed = parseTomlValue(value, filePath, lineNumber);
  if (typeof parsed !== "string") {
    throw new Error(`Expected TOML string array on line ${lineNumber} in ${filePath}`);
  }
  return parsed;
}

function stripInlineComment(line: string): string {
  let inQuotedString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = inQuotedString;
      continue;
    }
    if (character === "\"") {
      inQuotedString = !inQuotedString;
      continue;
    }
    if (character === "#" && !inQuotedString) {
      return line.slice(0, index);
    }
  }

  return line;
}

function unescapeQuotedString(
  value: string,
  filePath: string,
  lineNumber: number,
): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }

    index += 1;
    const escape = value[index];
    if (escape === undefined) {
      throw new Error(`Invalid TOML escape on line ${lineNumber} in ${filePath}`);
    }
    if (escape === "\\" || escape === "\"") {
      result += escape;
      continue;
    }
    if (escape === "n") {
      result += "\n";
      continue;
    }
    if (escape === "t") {
      result += "\t";
      continue;
    }
    throw new Error(`Unsupported TOML escape \\${escape} on line ${lineNumber} in ${filePath}`);
  }

  return result;
}

function formatOptionalTomlEntry(
  key: string,
  value: string | number | boolean | string[] | undefined,
): string | undefined {
  return value === undefined ? undefined : `${key} = ${formatTomlValue(value)}`;
}

function formatTomlValue(value: string | number | boolean | string[]): string {
  if (typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => formatTomlValue(item)).join(", ")}]`;
  }

  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}
