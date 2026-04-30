import { describe, expect, it } from "vitest";
import {
  DISCORD_APPLICATION_ID_ENV,
  DISCORD_AUTHORIZED_USER_IDS_ENV,
  DISCORD_BOT_TOKEN_ENV,
  loadDesktopMessagingConfig,
  redactDesktopMessagingConfig,
  TELEGRAM_AUTHORIZED_USER_IDS_ENV,
  TELEGRAM_BOT_TOKEN_ENV,
} from "../messaging/messaging-config";

describe("desktop messaging config", () => {
  it("enables configured channels only when tokens and authorized actors are present", () => {
    const config = loadDesktopMessagingConfig({
      [TELEGRAM_BOT_TOKEN_ENV]: " tg-token ",
      [TELEGRAM_AUTHORIZED_USER_IDS_ENV]: "user-1, user-2, user-1",
      [DISCORD_BOT_TOKEN_ENV]: "discord-token",
    });

    expect(config).toEqual({
      telegram: {
        channel: "telegram",
        botToken: "tg-token",
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
        authorizedActorIds: ["42"],
      },
      discord: {
        applicationId: "discord-app",
        botToken: "legacy-discord-token",
        authorizedActorIds: ["100", "200"],
      },
    });
  });

  it("redacts bot tokens while preserving useful diagnostics", () => {
    const redacted = redactDesktopMessagingConfig({
      telegram: {
        channel: "telegram",
        botToken: "secret-token",
        authorizedActorIds: ["1", "2"],
      },
      discord: {
        channel: "discord",
        applicationId: "app-id",
        botToken: "discord-secret",
        authorizedActorIds: ["3"],
      },
    });

    expect(JSON.stringify(redacted)).not.toContain("secret");
    expect(redacted).toEqual({
      telegram: {
        channel: "telegram",
        botToken: "[REDACTED]",
        authorizedActorCount: 2,
      },
      discord: {
        channel: "discord",
        applicationId: "app-id",
        botToken: "[REDACTED]",
        authorizedActorCount: 1,
      },
    });
  });
});
