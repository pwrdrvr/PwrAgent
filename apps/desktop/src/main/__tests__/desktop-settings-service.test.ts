import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopSettingsService } from "../settings/desktop-settings-service";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragnt-settings-"));
  tempRoots.push(root);
  return root;
}

describe("DesktopSettingsService", () => {
  it("loads TOML values from the desktop config path", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "tiptap-chips"',
        "",
        "[messaging.telegram]",
        "enabled = true",
        'authorized_user_ids = ["111111111", "222222222"]',
        "authorized_supergroups = []",
        "",
        "[messaging.discord]",
        'application_id = "123456789012345678"',
        'authorized_guilds = ["guild-one"]',
        "message_content_intent = true",
        "",
        "[models.codex]",
        'path = "codex-beta"',
      ].join("\n"),
      "utf8",
    );

    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
      now: () => 10,
    });

    const snapshot = await service.readSettings();

    expect(snapshot.fetchedAt).toBe(10);
    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "tiptap-chips",
      source: "config",
    });
    expect(snapshot.messaging.telegram.enabled).toEqual({
      value: true,
      source: "config",
    });
    expect(snapshot.messaging.telegram.authorizedUserIds.value).toEqual([
      "111111111",
      "222222222",
    ]);
    expect(snapshot.messaging.telegram.authorizedSupergroups.value).toEqual([]);
    expect(snapshot.messaging.discord.applicationId.value).toBe(
      "123456789012345678",
    );
    expect(snapshot.messaging.discord.authorizedGuilds.value).toEqual([
      "guild-one",
    ]);
    expect(snapshot.messaging.discord.messageContentIntent.value).toBe(true);
    expect(snapshot.models.codex.path).toEqual({
      value: "codex-beta",
      source: "config",
    });
  });

  it("applies env overrides above TOML and keeps the Grok API key in keychain", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[experimental]",
        'chat_reply_composer = "textarea"',
        "",
        "[messaging.telegram]",
        "enabled = false",
        'authorized_user_ids = ["111111111"]',
        "",
        "[models.codex]",
        'path = "codex-config"',
      ].join("\n"),
      "utf8",
    );
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("grokApiKey", "xai-keychain");

    const service = new DesktopSettingsService({
      configPath,
      env: {
        PWRAGNT_EXPERIMENTAL_CHAT_REPLY_COMPOSER: "custom-widget-chips",
        PWRAGNT_MESSAGING_TELEGRAM_ENABLED: "true",
        PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS: "222222222,333333333",
        PWRAGNT_CODEX_COMMAND: "codex-env",
        XAI_API_KEY: "xai-env",
      },
      secretStore,
    });

    const snapshot = await service.readSettings();

    expect(snapshot.experimental.chatReplyComposer).toMatchObject({
      value: "custom-widget-chips",
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.messaging.telegram.enabled).toMatchObject({
      value: true,
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.messaging.telegram.authorizedUserIds).toMatchObject({
      value: ["222222222", "333333333"],
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.models.codex.path).toMatchObject({
      value: "codex-env",
      source: "env",
      overriddenByEnv: true,
    });
    expect(snapshot.models.grok.apiKey).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
    expect(await service.resolveGrokApiKey()).toBe("xai-keychain");
    expect(service.resolveCodexCommandPreference()).toBe("codex-env");
  });

  it("writes non-secret patches without writing plaintext secrets to TOML", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    const secretStore = new MemoryDesktopSecretStore();
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore,
    });

    await service.writeConfigPatch({
      messaging: {
        telegram: {
          enabled: true,
          authorizedUserIds: ["111111111"],
          authorizedSupergroups: [],
        },
      },
      models: {
        codex: {
          path: "codex",
        },
      },
    });
    await service.replaceSecret("telegramBotToken", "123456789:secret-token");

    const contents = fs.readFileSync(configPath, "utf8");
    const snapshot = await service.readSettings();

    expect(contents).toContain("[messaging.telegram]");
    expect(contents).toContain('authorized_user_ids = ["111111111"]');
    expect(contents).not.toContain("123456789:secret-token");
    expect(JSON.stringify(snapshot)).not.toContain("123456789:secret-token");
    expect(snapshot.messaging.telegram.botToken).toMatchObject({
      configured: true,
      source: "keychain",
      writable: true,
    });
  });

  it("treats empty comma-separated env lists as empty lists", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {
        PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_GUILDS: " , ",
      },
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettings();

    expect(snapshot.messaging.discord.authorizedGuilds).toEqual({
      value: [],
      source: "env",
      overriddenByEnv: false,
    });
  });

  it("reports malformed TOML without throwing from readSettings", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(configPath, "[experimental]\nchat_reply_composer\n", "utf8");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const snapshot = await service.readSettings();

    expect(snapshot.configError).toContain("Invalid TOML line");
    expect(snapshot.experimental.chatReplyComposer).toEqual({
      value: "textarea",
      source: "default",
    });
  });

  it("refuses to overwrite malformed TOML on save", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      "[experimental]\nchat_reply_composer\n[messaging.telegram]\nenabled = true\n",
      "utf8",
    );
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    await expect(
      service.writeConfigPatch({
        experimental: {
          chatReplyComposer: "tiptap-chips",
        },
      }),
    ).rejects.toThrow("could not be parsed");
    expect(fs.readFileSync(configPath, "utf8")).toContain("chat_reply_composer");
    expect(fs.readFileSync(configPath, "utf8")).toContain("enabled = true");
  });

  it("reports unavailable secret storage and blocks secret writes", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore({
        available: false,
        backend: "unavailable",
        encrypted: false,
        unavailableReason: "No secure backend",
      }),
    });

    const snapshot = await service.readSettings();

    expect(snapshot.secretStorage.available).toBe(false);
    expect(snapshot.models.grok.apiKey).toMatchObject({
      configured: false,
      source: "unset",
      writable: false,
      unavailableReason: "No secure backend",
    });
    await expect(service.replaceSecret("grokApiKey", "xai-secret")).rejects.toThrow(
      "No secure backend",
    );
  });
});
