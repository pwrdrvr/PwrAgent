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
        diffCondensation: {
          enabled: { value: false, source: "default" },
          model: { value: "auto", source: "default" },
        },
      },
      messaging: {
        enabled: {
          value: true,
          source: "default",
        },
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
            value: [
              { id: "111111111", displayName: "" },
              { id: "222222222", displayName: "Harold" },
            ],
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
        mattermost: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: {
            configured: false,
            source: "unset",
            writable: true,
          },
          hmacSecret: {
            configured: false,
            source: "unset",
            writable: true,
          },
          serverUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedTeams: { value: [], source: "default" },
          authorizedConversations: { value: [], source: "default" },
        },
        slack: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          botToken: {
            configured: false,
            source: "unset",
            writable: true,
          },
          appToken: {
            configured: false,
            source: "unset",
            writable: true,
          },
          signingSecret: {
            configured: false,
            source: "unset",
            writable: true,
          },
          workspaceUrl: { value: "", source: "default" },
          inboundMode: { value: "socket", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedWorkspaces: { value: [], source: "default" },
        },
        line: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          channelAccessToken: {
            configured: false,
            source: "unset",
            writable: true,
          },
          channelSecret: {
            configured: false,
            source: "unset",
            writable: true,
          },
          webhookUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          botUserId: { value: "", source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedGroups: { value: [], source: "default" },
          authorizedRooms: { value: [], source: "default" },
        },
      },
      models: {
        codex: {
          path: { value: "", source: "default" },
          profile: { value: "", source: "default" },
          discovery: {
            candidates: [],
          },
          profiles: {
            profileRoot: "/home/example/.codex/profiles",
            effectiveCodexHome: "/home/example/.codex",
            profiles: [],
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
        gh: {
          path: { value: "", source: "default" },
          discovery: { candidates: [] },
        },
        git: {
          discovery: { candidates: [] },
        },
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

  it("validates the active composer option", () => {
    expect(isDesktopChatReplyComposer("textarea")).toBe(false);
    expect(isDesktopChatReplyComposer("tiptap-chips")).toBe(false);
    expect(isDesktopChatReplyComposer("tiptap-wysiwyg-markdown-chips")).toBe(true);
    expect(isDesktopChatReplyComposer("custom-widget-chips")).toBe(false);
    expect(isDesktopChatReplyComposer("markdown")).toBe(false);
  });
});
