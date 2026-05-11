import { describe, expect, it } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  buildDiscordPatchDelta,
  buildMattermostPatchDelta,
  buildTelegramPatchDelta,
} from "../settings-patch-delta";

type Telegram = DesktopSettingsSnapshot["messaging"]["telegram"];
type Discord = DesktopSettingsSnapshot["messaging"]["discord"];
type Mattermost = DesktopSettingsSnapshot["messaging"]["mattermost"];

function telegramSnapshot(overrides: Partial<Telegram> = {}): Telegram {
  return {
    enabled: { value: false, source: "default" },
    streamingResponses: { value: false, source: "default" },
    botToken: { configured: false, source: "unset", writable: true },
    authorizedUserIds: { value: [], source: "default" },
    authorizedSupergroups: { value: [], source: "default" },
    ...overrides,
  };
}

function discordSnapshot(overrides: Partial<Discord> = {}): Discord {
  return {
    enabled: { value: false, source: "default" },
    streamingResponses: { value: false, source: "default" },
    botToken: { configured: false, source: "unset", writable: true },
    applicationId: { value: "", source: "default" },
    authorizedUserIds: { value: [], source: "default" },
    authorizedGuilds: { value: [], source: "default" },
    ...overrides,
  };
}

function mattermostSnapshot(overrides: Partial<Mattermost> = {}): Mattermost {
  return {
    enabled: { value: false, source: "default" },
    streamingResponses: { value: false, source: "default" },
    botToken: { configured: false, source: "unset", writable: true },
    hmacSecret: { configured: false, source: "unset", writable: true },
    serverUrl: { value: "", source: "default" },
    callbackBaseUrl: { value: "", source: "default" },
    slashCommandPrefix: { value: "pwragent_", source: "default" },
    registerSlashCommands: { value: false, source: "default" },
    authorizedUserIds: { value: [], source: "default" },
    authorizedTeams: { value: [], source: "default" },
    authorizedConversations: { value: [], source: "default" },
    ...overrides,
  };
}

describe("buildTelegramPatchDelta", () => {
  it("returns undefined when nothing changed", () => {
    const snapshot = telegramSnapshot();
    expect(buildTelegramPatchDelta(snapshot, snapshot)).toBeUndefined();
  });

  it("emits only the field the user changed", () => {
    const snapshot = telegramSnapshot();
    const candidate: Telegram = {
      ...snapshot,
      streamingResponses: { ...snapshot.streamingResponses, value: true },
    };
    expect(buildTelegramPatchDelta(snapshot, candidate)).toEqual({
      streamingResponses: true,
    });
  });

  it("does not leak env-overridden values the user did not touch", () => {
    // Env says enabled=true; user toggles streaming, leaves enabled alone.
    const snapshot = telegramSnapshot({
      enabled: { value: true, source: "env", overriddenByEnv: true },
    });
    const candidate: Telegram = {
      ...snapshot,
      streamingResponses: { ...snapshot.streamingResponses, value: true },
    };
    const delta = buildTelegramPatchDelta(snapshot, candidate);
    expect(delta).toEqual({ streamingResponses: true });
    expect(delta).not.toHaveProperty("enabled");
  });

  it("writes a new value when the user actively overrides an env-sourced field", () => {
    // Env says enabled=true; user explicitly toggles to false.
    const snapshot = telegramSnapshot({
      enabled: { value: true, source: "env", overriddenByEnv: true },
    });
    const candidate: Telegram = {
      ...snapshot,
      enabled: { ...snapshot.enabled, value: false },
    };
    expect(buildTelegramPatchDelta(snapshot, candidate)).toEqual({
      enabled: false,
    });
  });

  it("compares string arrays element-wise", () => {
    const snapshot = telegramSnapshot({
      authorizedUserIds: {
        value: [
          { id: "111", displayName: "" },
          { id: "222", displayName: "Harold" },
        ],
        source: "config",
      },
    });
    const same: Telegram = {
      ...snapshot,
      authorizedUserIds: {
        ...snapshot.authorizedUserIds,
        value: [
          { id: "111", displayName: "" },
          { id: "222", displayName: "Harold" },
        ],
      },
    };
    expect(buildTelegramPatchDelta(snapshot, same)).toBeUndefined();

    const different: Telegram = {
      ...snapshot,
      authorizedUserIds: {
        ...snapshot.authorizedUserIds,
        value: [{ id: "333", displayName: "" }],
      },
    };
    expect(buildTelegramPatchDelta(snapshot, different)).toEqual({
      authorizedUserIds: [{ id: "333", displayName: "" }],
    });
  });
});

describe("buildDiscordPatchDelta", () => {
  it("returns undefined when nothing changed", () => {
    const snapshot = discordSnapshot();
    expect(buildDiscordPatchDelta(snapshot, snapshot)).toBeUndefined();
  });

  it("emits applicationId only when changed", () => {
    const snapshot = discordSnapshot({
      applicationId: { value: "old-id", source: "config" },
    });
    const same: Discord = {
      ...snapshot,
      applicationId: { ...snapshot.applicationId, value: "old-id" },
    };
    expect(buildDiscordPatchDelta(snapshot, same)).toBeUndefined();

    const different: Discord = {
      ...snapshot,
      applicationId: { ...snapshot.applicationId, value: "new-id" },
    };
    expect(buildDiscordPatchDelta(snapshot, different)).toEqual({
      applicationId: "new-id",
    });
  });

  it("does not leak env-sourced applicationId when other fields change", () => {
    const snapshot = discordSnapshot({
      applicationId: { value: "env-app", source: "env", overriddenByEnv: true },
    });
    const candidate: Discord = {
      ...snapshot,
      enabled: { ...snapshot.enabled, value: true },
    };
    const delta = buildDiscordPatchDelta(snapshot, candidate);
    expect(delta).toEqual({ enabled: true });
    expect(delta).not.toHaveProperty("applicationId");
  });
});

describe("buildMattermostPatchDelta", () => {
  it("emits shared-surface authorization changes", () => {
    const snapshot = mattermostSnapshot();
    const candidate: Mattermost = {
      ...snapshot,
      authorizedTeams: {
        ...snapshot.authorizedTeams,
        value: [{ id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" }],
      },
      authorizedConversations: {
        ...snapshot.authorizedConversations,
        value: [{ id: "channelabcdefghijklmn12345", displayName: "Town Square" }],
      },
    };

    expect(buildMattermostPatchDelta(snapshot, candidate)).toEqual({
      authorizedTeams: [
        { id: "teamabcdefghijklmnopqrstu1", displayName: "Dev Team" },
      ],
      authorizedConversations: [
        { id: "channelabcdefghijklmn12345", displayName: "Town Square" },
      ],
    });
  });
});
