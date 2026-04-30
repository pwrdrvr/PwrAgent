import { describe, expect, it } from "vitest";

import type { DesktopSettingsSnapshot } from "../settings";
import { isDesktopChatReplyComposer } from "../settings";

describe("desktop settings contracts", () => {
  it("represents read snapshots without raw secret values", () => {
    const snapshot: DesktopSettingsSnapshot = {
      fetchedAt: 1,
      configPath: "/tmp/pwragnt/config.toml",
      secretStorage: {
        available: true,
        backend: "safeStorage",
        encrypted: true,
      },
      experimental: {
        chatReplyComposer: {
          value: "textarea",
          source: "default",
        },
      },
      messaging: {
        telegram: {
          enabled: { value: true, source: "config" },
          botToken: {
            configured: true,
            source: "keychain",
            writable: true,
          },
          authorizedUserIds: {
            value: ["111111111", "222222222"],
            source: "config",
          },
          authorizedSupergroups: {
            value: [],
            source: "config",
          },
        },
        discord: {
          enabled: { value: false, source: "default" },
          botToken: {
            configured: true,
            source: "env",
            writable: false,
            overriddenByEnv: true,
          },
          applicationId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGuilds: { value: [], source: "default" },
          messageContentIntent: { value: false, source: "default" },
        },
      },
      models: {
        codex: {
          path: { value: "", source: "default" },
          discovery: {
            candidates: [],
          },
        },
        grok: {
          apiKey: {
            configured: false,
            source: "unset",
            writable: true,
          },
        },
      },
    };

    const encoded = JSON.stringify(snapshot);

    expect(encoded).toContain("keychain");
    expect(encoded).not.toContain("123456789:");
    expect(encoded).not.toContain("discord-token");
    expect(encoded).not.toContain("xai-");
  });

  it("validates the supported composer options", () => {
    expect(isDesktopChatReplyComposer("textarea")).toBe(true);
    expect(isDesktopChatReplyComposer("tiptap-chips")).toBe(true);
    expect(isDesktopChatReplyComposer("custom-widget-chips")).toBe(true);
    expect(isDesktopChatReplyComposer("markdown")).toBe(false);
  });
});
