import type {
  DesktopChatReplyComposer,
  DesktopSettingsConfigPatch,
  DesktopSettingsSecretName,
  DesktopSettingsSecretState,
  DesktopSettingsSnapshot,
  DesktopSettingsValue,
} from "@pwragnt/shared";
import {
  mergeDesktopSettingsConfig,
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
  writeDesktopSettingsConfig,
  type DesktopSettingsConfig,
} from "./desktop-config";
import type { DesktopSecretStore } from "./desktop-secret-store";
import {
  CHAT_REPLY_COMPOSER_ENV,
  CODEX_COMMAND_ENV,
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_GUILDS_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  DISCORD_ENABLED_ENV,
  DISCORD_MESSAGE_CONTENT_INTENT_ENV,
  TELEGRAM_AUTHORIZED_SUPERGROUPS_ENV,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
  TELEGRAM_ENABLED_ENV,
  readEnvBoolean,
  readEnvComposer,
  readEnvList,
  readEnvString,
} from "./desktop-settings-env";
import { discoverCodexCommands } from "./codex-discovery";
import { discoverDesktopApplications } from "./application-discovery";

type DesktopSettingsServiceOptions = {
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  secretStore: DesktopSecretStore;
  now?: () => number;
};

type ConfigReadResult = {
  config: DesktopSettingsConfig;
  error?: string;
};

export class DesktopSettingsService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly configPath: string;
  private readonly now: () => number;

  constructor(private readonly options: DesktopSettingsServiceOptions) {
    this.env = options.env ?? process.env;
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
    const grokApiKey = await this.readSecretState(
      "grokApiKey",
      undefined,
      secretStorage.available,
    );
    const codexDiscovery = await discoverCodexCommands({
      configuredCommand: config.models?.codex?.path,
      env: this.env,
    });
    const applications = await discoverDesktopApplications({ env: this.env });
    const preferredEditorId = this.resolveConfigString(
      config.applications?.editor?.preferredId,
    );
    const preferredTerminalId = this.resolveConfigString(
      config.applications?.terminal?.preferredId,
    );

    return {
      fetchedAt: this.now(),
      configPath: this.configPath,
      configError: error,
      secretStorage,
      experimental: {
        chatReplyComposer: this.resolveComposer(
          config.experimental?.chatReplyComposer,
        ),
      },
      messaging: {
        telegram: {
          enabled: this.resolveBoolean(
            config.messaging?.telegram?.enabled,
            false,
            TELEGRAM_ENABLED_ENV,
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
          messageContentIntent: this.resolveBoolean(
            config.messaging?.discord?.messageContentIntent,
            false,
            DISCORD_MESSAGE_CONTENT_INTENT_ENV,
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
      },
    };
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
    writeDesktopSettingsConfig(
      this.configPath,
      mergeDesktopSettingsConfig(current.config, patch),
    );
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
      value: configValue ?? "textarea",
      source: configValue === undefined ? "default" : "config",
      error: envValue.error,
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

  private resolveConfigString(
    configValue: string | undefined,
  ): DesktopSettingsValue<string> {
    return {
      value: configValue ?? "",
      source: configValue === undefined ? "default" : "config",
    };
  }

  private resolveList(
    configValue: string[] | undefined,
    envKey: string,
  ): DesktopSettingsValue<string[]> {
    const envValue = readEnvList(this.env, envKey);
    if (envValue !== undefined) {
      return {
        value: envValue,
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
}
