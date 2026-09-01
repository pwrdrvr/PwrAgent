import { describe, expect, it } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import {
  applyConfigUpdateToSettingsSnapshot,
  applySecretUpdateToSettingsSnapshot,
} from "../settings-snapshot-updates";

describe("settings snapshot updates", () => {
  it("applies normalized config leaves without replacing unrelated state", () => {
    const snapshot = {
      fetchedAt: 1,
      general: {
        developerMode: { value: false, source: "default" },
        notificationsEnabled: { value: true, source: "default" },
      },
      messaging: {
        enabled: { value: false, source: "env" },
      },
    } as unknown as DesktopSettingsSnapshot;

    const next = applyConfigUpdateToSettingsSnapshot(snapshot, {
      general: { developerMode: true },
      messaging: { enabled: true },
    });

    expect(next).not.toBe(snapshot);
    expect(next.general.developerMode).toEqual({
      value: true,
      source: "config",
    });
    expect(next.general.notificationsEnabled).toBe(
      snapshot.general.notificationsEnabled,
    );
    expect(next.messaging.enabled).toEqual({
      value: false,
      source: "env",
      overriddenByEnv: true,
    });
  });

  it("updates only the named secret state", () => {
    const snapshot = {
      messaging: {
        discord: {
          botToken: { configured: false, source: "unset", writable: true },
        },
        telegram: {
          botToken: { configured: true, source: "keychain", writable: true },
        },
      },
    } as unknown as DesktopSettingsSnapshot;
    const state = {
      configured: true,
      source: "keychain" as const,
      writable: true,
    };

    const next = applySecretUpdateToSettingsSnapshot(
      snapshot,
      "discordBotToken",
      state,
    );

    expect(next.messaging.discord.botToken).toEqual(state);
    expect(next.messaging.telegram).toBe(snapshot.messaging.telegram);
  });
});
