import type {
  DesktopChatReplyComposer,
  DesktopAuthorizedContact,
  DesktopMessagingImageProfile,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
  DesktopWorktreeStorageLocation,
  MessagingToolUpdateMode,
} from "@pwragent/shared";
import {
  DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
  DESKTOP_WORKTREE_STORAGE_DEFAULT,
} from "@pwragent/shared";
import {
  applyDesktopSettingsPatch,
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
  userHomeWorktreesRoot,
  type DesktopSettingsConfig,
} from "./desktop-config";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import type { DesktopSecretStore } from "./desktop-secret-store";
import {
  CHAT_REPLY_COMPOSER_ENV,
  CODEX_COMMAND_ENV,
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_STREAMING_RESPONSES_ENV,
  GH_COMMAND_ENV,
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
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  TELEGRAM_STREAMING_RESPONSES_ENV,
  WORKTREE_STORAGE_ENV,
  readEnvBoolean,
  readEnvComposer,
  readEnvInteger,
  readEnvList,
  readEnvMessagingImageProfile,
  readEnvString,
  readEnvWorktreeStorage,
} from "./desktop-settings-env";
import { discoverCodexCommands } from "./codex-discovery";
import { discoverDesktopApplications } from "./application-discovery";
import { discoverGhCommands } from "./gh-discovery";

type DesktopSettingsServiceOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  argv?: readonly string[];
  secretStore: DesktopSecretStore;
  now?: () => number;
};

type ConfigReadResult = {
  config: DesktopSettingsConfig;
  error?: string;
};

const DEFAULT_MESSAGING_INPUT_DEBOUNCE_MS = 500;
const MAX_MESSAGING_INPUT_DEBOUNCE_MS = 5_000;

function clampInteger(value: number, maxValue: number): number {
  return Math.min(Math.max(value, 0), maxValue);
}

export class DesktopSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly argv: readonly string[];
  private readonly configPath: string;
  private readonly now: () => number;

  constructor(private readonly options: DesktopSettingsServiceOptions) {
    this.env = options.env ?? process.env;
    this.argv = options.argv ?? process.argv;
    this.configPath =
      options.configPath ?? resolveDesktopConfigPath({ env: this.env });
    this.now = options.now ?? Date.now;
  }

  async readSettings(): Promise<DesktopSettingsSnapshot> {
    const { config, error } = this.readConfig();
    const secretStorage = this.options.secretStore.describe();

    const telegramBotToken = await this.readSecretState(
      "telegramBotToken",
      TELEGRAM_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const discordBotToken = await this.readSecretState(
      "discordBotToken",
      DISCORD_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const mattermostBotToken = await this.readSecretState(
      "mattermostBotToken",
      MATTERMOST_BOT_TOKEN_ENV,
      secretStorage.available,
    );
    const mattermostHmacSecret = await this.readSecretState(
      "mattermostHmacSecret",
      MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
      secretStorage.available,
    );
    const grokApiKey = await this.readSecretState(
      "grokApiKey",
      undefined,
      secretStorage.available,
    );
    const codexDiscovery = await discoverCodexCommands({
      configuredCommand: config.models?.codex?.path,
      env: this.env,
    });
    const ghDiscovery = await discoverGhCommands({
      configuredCommand: config.applications?.gh?.path,
      env: this.env,
    });
    const applications = await discoverDesktopApplications({ env: this.env });
    const preferredEditorId = this.resolveConfigString(
      config.applications?.editor?.preferredId,
    );
    const preferredTerminalId = this.resolveConfigString(
      config.applications?.terminal?.preferredId,
    );
    const messagingOverride = resolveRuntimeMessagingOverride({
      argv: this.argv,
      env: this.env,
    });

    return {
      fetchedAt: this.now(),
      configPath: this.configPath,
      configError: error,
      runtime: {
        messaging: {
          disabled: messagingOverride.disabled,
          ...(messagingOverride.reason
            ? { disabledReason: messagingOverride.reason }
            : {}),
        },
      },
      secretStorage,
      experimental: {
        chatReplyComposer: this.resolveComposer(
          config.experimental?.chatReplyComposer,
        ),
        diffCondensation: {
          enabled: this.resolveDiffCondensationEnabled(
            config.experimental?.diffCondensation?.enabled,
          ),
          model: this.resolveDiffCondensationModel(
            config.experimental?.diffCondensation?.model,
          ),
        },
      },
      messaging: {
        inputDebounceMs: this.resolveClampedNumber(
          config.messaging?.inputDebounceMs,
          DEFAULT_MESSAGING_INPUT_DEBOUNCE_MS,
          MESSAGING_INPUT_DEBOUNCE_MS_ENV,
          MAX_MESSAGING_INPUT_DEBOUNCE_MS,
        ),
        toolUpdateMode: this.resolveToolUpdateMode(
          config.messaging?.toolUpdateMode,
        ),
        attachments: {
          imageProfile: this.resolveMessagingImageProfile(
            config.messaging?.attachments?.imageProfile,
          ),
          maxAttachmentBytes: this.resolveNumber(
            config.messaging?.attachments?.maxAttachmentBytes,
            10 * 1024 * 1024,
            MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
          ),
          maxAttachmentCount: this.resolveNumber(
            config.messaging?.attachments?.maxAttachmentCount,
            4,
            MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
          ),
        },
        telegram: {
          enabled: this.resolveBoolean(
            config.messaging?.telegram?.enabled,
            false,
            TELEGRAM_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.telegram?.streamingResponses,
            false,
            TELEGRAM_STREAMING_RESPONSES_ENV,
          ),
          botToken: telegramBotToken,
          authorizedUserIds: this.resolveList(
            config.messaging?.telegram?.authorizedUserIds,
            TELEGRAM_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedSupergroups: this.resolveList(
            config.messaging?.telegram?.authorizedSupergroups,
            TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
          ),
        },
        discord: {
          enabled: this.resolveBoolean(
            config.messaging?.discord?.enabled,
            false,
            DISCORD_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.discord?.streamingResponses,
            false,
            DISCORD_STREAMING_RESPONSES_ENV,
          ),
          botToken: discordBotToken,
          applicationId: this.resolveString(
            config.messaging?.discord?.applicationId,
            DISCORD_APPLICATION_ID_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.discord?.authorizedUserIds,
            DISCORD_AUTHORIZED_USER_IDS_ENV,
          ),
          authorizedGuilds: this.resolveList(
            config.messaging?.discord?.authorizedGuilds,
            DISCORD_AUTHORIZED_GUILDS_ENV,
          ),
        },
        mattermost: {
          enabled: this.resolveBoolean(
            config.messaging?.mattermost?.enabled,
            false,
            MATTERMOST_ENABLED_ENV,
          ),
          streamingResponses: this.resolveBoolean(
            config.messaging?.mattermost?.streamingResponses,
            false,
            MATTERMOST_STREAMING_RESPONSES_ENV,
          ),
          botToken: mattermostBotToken,
          hmacSecret: mattermostHmacSecret,
          serverUrl: this.resolveString(
            config.messaging?.mattermost?.serverUrl,
            MATTERMOST_SERVER_URL_ENV,
          ),
          callbackBaseUrl: this.resolveString(
            config.messaging?.mattermost?.callbackBaseUrl,
            MATTERMOST_CALLBACK_BASE_URL_ENV,
          ),
          slashCommandPrefix: this.resolveStringWithDefault(
            config.messaging?.mattermost?.slashCommandPrefix,
            "pwragent_",
            MATTERMOST_SLASH_COMMAND_PREFIX_ENV,
          ),
          registerSlashCommands: this.resolveBoolean(
            config.messaging?.mattermost?.registerSlashCommands,
            false,
            MATTERMOST_REGISTER_SLASH_COMMANDS_ENV,
          ),
          authorizedUserIds: this.resolveList(
            config.messaging?.mattermost?.authorizedUserIds,
            MATTERMOST_AUTHORIZED_USER_IDS_ENV,
          ),
        },
      },
      models: {
        codex: {
          path: this.resolveString(config.models?.codex?.path, CODEX_COMMAND_ENV),
          discovery: codexDiscovery,
        },
        grok: {
          apiKey: grokApiKey,
        },
      },
      applications: {
        ...applications,
        preferredEditorId,
        preferredTerminalId,
        gh: {
          path: this.resolveString(config.applications?.gh?.path, GH_COMMAND_ENV),
          discovery: ghDiscovery,
        },
      },
      worktrees: this.resolveWorktrees(config.worktrees?.storage),
    };
  }

  resolveWorktreeStorage(): DesktopWorktreeStorageLocation {
    return this.resolveWorktrees(this.readConfig().config.worktrees?.storage)
      .storage.value;
  }

  async writeConfigPatch(
    patch: DesktopSettingsConfigPatch,
  ): Promise<DesktopSettingsSnapshot> {
    const current = this.readConfig();
    if (current.error) {
      throw new Error(
        `Cannot save settings because ${this.configPath} could not be parsed: ${current.error}`,
      );
    }
    applyDesktopSettingsPatch(this.configPath, patch);
    return this.readSettings();
  }

  async replaceSecret(
    secret: DesktopSettingsSecretName,
    value: string,
  ): Promise<DesktopSettingsSnapshot> {
    await this.options.secretStore.setSecret(secret, value);
    return this.readSettings();
  }

  async clearSecret(
    secret: DesktopSettingsSecretName,
  ): Promise<DesktopSettingsSnapshot> {
    await this.options.secretStore.deleteSecret(secret);
    return this.readSettings();
  }

  async resolveGrokApiKey(): Promise<string | undefined> {
    return await this.options.secretStore.getSecret("grokApiKey");
  }

  resolveTelegramBotTokenSync(): string | undefined {
    return this.resolveSecretSync("telegramBotToken", TELEGRAM_BOT_TOKEN_ENV);
  }

  resolveDiscordBotTokenSync(): string | undefined {
    return this.resolveSecretSync("discordBotToken", DISCORD_BOT_TOKEN_ENV);
  }

  resolveMattermostBotTokenSync(): string | undefined {
    return this.resolveSecretSync(
      "mattermostBotToken",
      MATTERMOST_BOT_TOKEN_ENV,
    );
  }

  resolveMattermostHmacSecretSync(): string | undefined {
    return this.resolveSecretSync(
      "mattermostHmacSecret",
      MATTERMOST_CALLBACK_HMAC_SECRET_ENV,
    );
  }

  resolveMattermostServerUrlSync(): string | undefined {
    return (
      readEnvString(this.env, MATTERMOST_SERVER_URL_ENV)
      ?? this.readConfig().config.messaging?.mattermost?.serverUrl
      ?? undefined
    );
  }

  resolveGrokApiKeySync(): string | undefined {
    return this.options.secretStore.getSecretSync?.("grokApiKey");
  }

  resolveCodexCommandPreference(): string | undefined {
    return (
      readEnvString(this.env, CODEX_COMMAND_ENV)
      || this.readConfig().config.models?.codex?.path
      || undefined
    );
  }

  resolveGhCommandPreference(): string | undefined {
    return (
      readEnvString(this.env, GH_COMMAND_ENV)
      || this.readConfig().config.applications?.gh?.path
      || undefined
    );
  }

  private readConfig(): ConfigReadResult {
    try {
      return {
        config: readDesktopSettingsConfig(this.configPath),
      };
    } catch (error) {
      return {
        config: {},
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveComposer(
    configValue: DesktopChatReplyComposer | undefined,
  ): DesktopSettingsValue<DesktopChatReplyComposer> {
    const envValue = readEnvComposer(this.env);
    if (envValue.value) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? DESKTOP_CHAT_REPLY_COMPOSER_DEFAULT,
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveDiffCondensationEnabled(
    configValue: boolean | undefined,
  ): DesktopSettingsValue<boolean> {
    return {
      value: configValue ?? false,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveDiffCondensationModel(
    configValue: string | undefined,
  ): DesktopSettingsValue<string> {
    const trimmed = configValue?.trim();
    return {
      value: trimmed && trimmed.length > 0 ? trimmed : "auto",
      source: trimmed && trimmed.length > 0 ? "config" : "default",
    };
  }

  private resolveBoolean(
    configValue: boolean | undefined,
    defaultValue: boolean,
    envKey: string,
  ): DesktopSettingsValue<boolean> {
    const envValue = readEnvBoolean(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveMessagingImageProfile(
    configValue: DesktopMessagingImageProfile | undefined,
  ): DesktopSettingsValue<DesktopMessagingImageProfile> {
    const envValue = readEnvMessagingImageProfile(this.env);
    if (envValue.value) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "medium",
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveNumber(
    configValue: number | undefined,
    defaultValue: number,
    envKey: string,
  ): DesktopSettingsValue<number> {
    const envValue = readEnvInteger(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: envValue.value,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveClampedNumber(
    configValue: number | undefined,
    defaultValue: number,
    envKey: string,
    maxValue: number,
  ): DesktopSettingsValue<number> {
    const envValue = readEnvInteger(this.env, envKey);
    if (envValue.value !== undefined) {
      return {
        value: clampInteger(envValue.value, maxValue),
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: clampInteger(configValue ?? defaultValue, maxValue),
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
    };
  }

  private resolveString(
    configValue: string | undefined,
    envKey: string,
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveStringWithDefault(
    configValue: string | undefined,
    defaultValue: string,
    envKey: string,
  ): DesktopSettingsValue<string> {
    const envValue = readEnvString(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? defaultValue,
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveConfigString(
    configValue: string | undefined,
  ): DesktopSettingsValue<string> {
    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveToolUpdateMode(
    configValue: MessagingToolUpdateMode | undefined,
  ): DesktopSettingsValue<MessagingToolUpdateMode> {
    return {
      value: configValue ?? "show_some",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveWorktrees(
    configValue: DesktopWorktreeStorageLocation | undefined,
  ): {
    storage: DesktopSettingsValue<DesktopWorktreeStorageLocation>;
    effectivePath: string;
  } {
    const envValue = readEnvWorktreeStorage(this.env);
    const resolved: DesktopSettingsValue<DesktopWorktreeStorageLocation> =
      envValue.value !== undefined
        ? {
            value: envValue.value,
            source: "env",
            overriddenByEnv: configValue !== undefined,
          }
        : {
            value: configValue ?? DESKTOP_WORKTREE_STORAGE_DEFAULT,
            source: configValue === undefined ? "default" : "config",
            error: envValue.error,
          };
    return {
      storage: resolved,
      effectivePath:
        resolved.value === "user-home"
          ? userHomeWorktreesRoot()
          : ".worktrees",
    };
  }

  private resolveList(
    configValue: DesktopAuthorizedContact[] | undefined,
    envKey: string,
  ): DesktopSettingsValue<DesktopAuthorizedContact[]> {
    const envValue = readEnvList(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue.map((id) => ({ id, displayName: "" })),
        source: "env",
        overriddenByEnv: configValue !== undefined,
      };
    }

    return {
      value: configValue ?? [],
      source: configValue === undefined ? "default" : "config",
    };
  }

  private async readSecretState(
    secret: DesktopSettingsSecretName,
    envKey: string | undefined,
    storageAvailable: boolean,
  ): Promise<DesktopSettingsSecretState> {
    if (envKey && readEnvString(this.env, envKey)) {
      return {
        configured: true,
        source: "env",
        writable: false,
        overriddenByEnv: true,
      };
    }

    const storageState = this.options.secretStore.describe();
    if (!storageAvailable) {
      return {
        configured: false,
        source: "unset",
        writable: false,
        unavailableReason: storageState.unavailableReason,
      };
    }

    try {
      const value = await this.options.secretStore.getSecret(secret);
      return {
        configured: Boolean(value),
        source: value ? "keychain" : "unset",
        writable: true,
      };
    } catch (error) {
      return {
        configured: false,
        source: "unset",
        writable: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private resolveSecretSync(
    secret: DesktopSettingsSecretName,
    envKey: string | undefined,
  ): string | undefined {
    return (
      (envKey ? readEnvString(this.env, envKey) : undefined)
      ?? this.options.secretStore.getSecretSync?.(secret)
    );
  }
}
