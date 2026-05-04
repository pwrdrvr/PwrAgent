import { describe, expect, it } from "vitest";

import type { DesktopSettingsSnapshot } from "../settings";
import { isDesktopChatReplyComposer } from "../settings";

describe("desktop settings contracts", () => {
  it("represents read snapshots without raw secret values", () => {
    const snapshot: DesktopSettingsSnapshot = {
      fetchedAt: 1,
      configPath: "/tmp/pwragent/config.toml",
      runtime: {
        messaging: {
          disabled: false,
        },
      },
      secretStorage: {
        available: true,
        backend: "safeStorage",
        encrypted: true,
      },
      experimental: {
        chatReplyComposer: {
          value: "tiptap-wysiwyg-markdown-chips",
          source: "default",
        },
      },
      messaging: {
        inputDebounceMs: {
          value: 500,
          source: "default",
        },
        toolUpdateMode: {
          value: "show_some",
          source: "default",
        },
        attachments: {
          imageProfile: { value: "medium", source: "default" },
          maxAttachmentBytes: { value: 10485760, source: "default" },
          maxAttachmentCount: { value: 4, source: "default" },
        },
        telegram: {
          enabled: { value: true, source: "config" },
          streamingResponses: { value: true, source: "config" },
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
          streamingResponses: { value: false, source: "default" },
          botToken: {
            configured: true,
            source: "env",
            writable: false,
            overriddenByEnv: true,
          },
          applicationId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGuilds: { value: [], source: "default" },
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
      applications: {
        editors: [],
        terminals: [],
        preferredEditorId: { value: "", source: "default" },
        preferredTerminalId: { value: "", source: "default" },
      },
      worktrees: {
        storage: { value: "user-home", source: "default" },
        effectivePath: "/home/example/.pwragent/worktrees",
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
    expect(isDesktopChatReplyComposer("tiptap-wysiwyg-markdown-chips")).toBe(true);
    expect(isDesktopChatReplyComposer("custom-widget-chips")).toBe(true);
    expect(isDesktopChatReplyComposer("markdown")).toBe(false);
  });
});
