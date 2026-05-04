import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  loadDesktopMessagingConfig,
  loadDesktopMessagingConfigFromSettings,
  MESSAGING_ATTACHMENT_MAX_BYTES_ENV,
  MESSAGING_ATTACHMENT_MAX_COUNT_ENV,
  MESSAGING_INPUT_DEBOUNCE_MS_ENV,
  redactDesktopMessagingConfig,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
} from "../messaging/messaging-config";
import { MemoryDesktopSecretStore } from "../settings/desktop-secret-store";
import { DesktopSettingsService } from "../settings/desktop-settings-service";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("desktop messaging config", () => {
  it("enables configured channels only when tokens and authorized actors are present", () => {
    const config = loadDesktopMessagingConfig({
      [TELEGRAM_BOT_TOKEN_ENV]: " tg-token ",
      [TELEGRAM_AUTHORIZED_USER_IDS_ENV]: "user-1, user-2, user-1",
      [DISCORD_BOT_TOKEN_ENV]: "discord-token",
    });

    expect(config).toEqual({
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      telegram: {
        channel: "telegram",
        enabled: true,
        botToken: "tg-token",
        streamingResponses: false,
        authorizedActorIds: ["user-1", "user-2"],
      },
    });
  });

  it("supports legacy bot token aliases for local testing", () => {
    const config = loadDesktopMessagingConfig({
      TELEGRAM_BOT_TOKEN: "legacy-tg-token",
      [TELEGRAM_AUTHORIZED_USER_IDS_ENV]: "42",
      DISCORD_BOT_TOKEN: "legacy-discord-token",
      [DISCORD_APPLICATION_ID_ENV]: "discord-app",
      [DISCORD_AUTHORIZED_USER_IDS_ENV]: "100,200",
    });

    expect(config).toMatchObject({
      telegram: {
        botToken: "legacy-tg-token",
        streamingResponses: false,
        authorizedActorIds: ["42"],
      },
      discord: {
        applicationId: "discord-app",
        botToken: "legacy-discord-token",
        streamingResponses: false,
        authorizedActorIds: ["100", "200"],
      },
    });
  });

  it("loads enabled providers from desktop settings and keychain secrets", async () => {
    const root = createTempRoot();
    const configPath = path.join(root, "config.toml");
    fs.writeFileSync(
      configPath,
      [
        "[messaging.telegram]",
        "enabled = true",
        "streaming_responses = true",
        'authorized_user_ids = ["111111111"]',
        "",
        "[messaging.discord]",
        "enabled = true",
        "streaming_responses = true",
        'application_id = "discord-app"',
        'authorized_user_ids = ["222222222"]',
      ].join("\n"),
      "utf8",
    );
    const secretStore = new MemoryDesktopSecretStore();
    await secretStore.setSecret("telegramBotToken", "settings-telegram-token");
    await secretStore.setSecret("discordBotToken", "settings-discord-token");
    const service = new DesktopSettingsService({
      configPath,
      env: {},
      secretStore,
    });

    const config = await loadDesktopMessagingConfigFromSettings(service, {});

    expect(config).toEqual({
      inputDebounceMs: 500,
      toolUpdateDefaultMode: "show_some",
      attachmentPolicy: {
        imageProfile: "medium",
        maxAttachmentBytes: 10485760,
        maxAttachmentCount: 4,
      },
      telegram: {
        channel: "telegram",
        enabled: true,
        botToken: "settings-telegram-token",
        streamingResponses: true,
        authorizedActorIds: ["111111111"],
      },
      discord: {
        channel: "discord",
        enabled: true,
        applicationId: "discord-app",
        botToken: "settings-discord-token",
        streamingResponses: true,
        authorizedActorIds: ["222222222"],
      },
    });
  });

  it("keeps env-only messaging config fallback enabled for tests", async () => {
    const service = new DesktopSettingsService({
      configPath: path.join(createTempRoot(), "config.toml"),
      env: {},
      secretStore: new MemoryDesktopSecretStore(),
    });

    const config = await loadDesktopMessagingConfigFromSettings(service, {
      [TELEGRAM_BOT_TOKEN_ENV]: "env-telegram-token",
      [TELEGRAM_AUTHORIZED_USER_IDS_ENV]: "42",
    });

    expect(config.telegram).toMatchObject({
      botToken: "env-telegram-token",
      streamingResponses: false,
      authorizedActorIds: ["42"],
    });
  });

  it("treats blank attachment integer env vars as unset", () => {
    const config = loadDesktopMessagingConfig({
      [MESSAGING_ATTACHMENT_MAX_BYTES_ENV]: "  ",
      [MESSAGING_ATTACHMENT_MAX_COUNT_ENV]: "",
    });

    expect(config.attachmentPolicy).toBeUndefined();
    expect(config.inputDebounceMs).toBe(500);
  });

  it("loads and caps the input debounce env override", () => {
    expect(
      loadDesktopMessagingConfig({
        [MESSAGING_INPUT_DEBOUNCE_MS_ENV]: "9999",
      }).inputDebounceMs,
    ).toBe(5000);
  });

  it("redacts bot tokens while preserving useful diagnostics", () => {
    const redacted = redactDesktopMessagingConfig({
      telegram: {
        channel: "telegram",
        botToken: "secret-token",
        streamingResponses: true,
        authorizedActorIds: ["1", "2"],
      },
      discord: {
        channel: "discord",
        applicationId: "app-id",
        botToken: "discord-secret",
        streamingResponses: false,
        authorizedActorIds: ["3"],
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(redacted).toEqual({
      telegram: {
        channel: "telegram",
        enabled: true,
        botToken: "[REDACTED]",
        streamingResponses: true,
        authorizedActorCount: 2,
      },
      toolUpdateDefaultMode: "show_some",
      inputDebounceMs: 500,
      discord: {
        channel: "discord",
        enabled: true,
        applicationId: "app-id",
        botToken: "[REDACTED]",
        streamingResponses: false,
        authorizedActorCount: 1,
      },
    });
  });
});

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-messaging-config-"));
  tempRoots.push(root);
  return root;
}
