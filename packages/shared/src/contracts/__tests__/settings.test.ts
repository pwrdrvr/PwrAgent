import { describe, expect, it } from "vitest";

import type { DesktopSettingsSnapshot } from "../settings";
import {
  inferDesktopUpdateSelection,
  isDesktopChatReplyComposer,
} from "../settings";

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
      general: {
        confirmQuitWithInProgressThreads: {
          value: true,
          source: "default",
        },
        attentionPromoteOnTurnEnd: {
          value: true,
          source: "default",
        },
        developerMode: {
          value: false,
          source: "default",
        },
        pdfAnalysisEnabled: {
          value: true,
          source: "default",
        },
        hotCpuProfilingEnabled: {
          value: false,
          source: "default",
        },
        hotCpuProfilingStartDelayMs: {
          value: 0,
          source: "default",
        },
        hotCpuProfilingTriggerMode: {
          value: "sustained",
          source: "default",
        },
        hotCpuProfilingSlowburnThresholdPercent: {
          value: 15,
          source: "default",
        },
        hotCpuProfilingCaptureHeapSnapshot: {
          value: false,
          source: "default",
        },
        hotCpuProfilingHeapSnapshotLimit: {
          value: 2,
          source: "default",
        },
        notificationsEnabled: {
          value: false,
          source: "default",
        },
        toolOutputAlerts: {
          outputCapHitsEnabled: { value: false, source: "default" },
          repeatedLargeOutputsEnabled: { value: false, source: "default" },
          repeatedLargeOutputMinimumCalls: { value: 5, source: "default" },
          repeatedLargeOutputMinimumPercent: { value: 50, source: "default" },
          repeatedQueuedChecksEnabled: { value: false, source: "default" },
        },
        spendAlerts: {
          activeTurnSpendEnabled: { value: false, source: "default" },
          activeTurnSpendThresholdUsd: { value: 5, source: "default" },
          threadSpendEnabled: { value: true, source: "default" },
          threadSpendThresholdUsd: { value: 25, source: "default" },
        },
        appearance: {
          theme: { value: "system", source: "default" },
          density: { value: "mission-control", source: "default" },
          sidebarTextSize: { value: "md", source: "default" },
          transcriptTextSize: { value: "md", source: "default" },
        },
        codexProfileModel: { value: "shared", source: "default" },
        messagingAcknowledgment: { value: null, source: "default" },
      },
      onboarding: {
        completed: { value: true, source: "default" },
        completedSource: { value: "migrated", source: "default" },
      },
      experimental: {
        chatReplyComposer: {
          value: "tiptap-wysiwyg-markdown-chips",
          source: "default",
        },
        fullAccessRiskWarningDismissed: {
          value: false,
          source: "default",
        },
        liveTranscriptEventFiltering: {
          value: false,
          source: "default",
        },
        lightweightNavigationRefresh: {
          value: false,
          source: "default",
        },
        threadPricingSummary: {
          value: true,
          source: "default",
        },
        threadPricingDisplayUsd: {
          value: true,
          source: "default",
        },
        threadPricingDisplayCodexCredits: {
          value: false,
          source: "default",
        },
        threadToolAccounting: {
          value: false,
          source: "default",
        },
        codexDefaultModeRequestUserInput: {
          value: false,
          source: "default",
        },
        diffCondensation: {
          enabled: { value: false, source: "default" },
        },
      },
      imageUploads: {
        pastedImageMaxPatches: { value: 1536, source: "default" },
      },
      updates: {
        channel: { value: "latest", source: "default" },
        train: { value: "stable", source: "default" },
      },
      integratedTerminal: {
        windowsShell: { value: "auto", source: "default" },
      },
      ui: {
        sidebarHidden: { value: false, source: "default" },
        contextRailPinned: { value: false, source: "default" },
        activeContextTab: { value: "info", source: "default" },
        editedFilesDock: { value: "above", source: "default" },
        actionRunsDock: { value: "above", source: "default" },
      },
      federation: {
        mode: { value: "disabled", source: "default" },
        instanceLabel: { value: "", source: "default" },
        instanceNotes: { value: "", source: "default" },
        listenHost: { value: "127.0.0.1", source: "default" },
        listenPort: { value: 8765, source: "default" },
        publicUrl: { value: "", source: "default" },
        gatewayUrl: { value: "", source: "default" },
        gatewayEndpoints: { value: [], source: "default" },
        advertisedEndpoints: { value: [], source: "default" },
        cloudflareEndpoint: { value: "", source: "default" },
        cloudflareMtlsEnabled: { value: false, source: "default" },
        cloudflareAccessServiceAuthEnabled: { value: false, source: "default" },
        instancePrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        noiseStaticPrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareClientCertificate: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareClientPrivateKey: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareAccessClientId: {
          configured: false,
          source: "unset",
          writable: true,
        },
        cloudflareAccessClientSecret: {
          configured: false,
          source: "unset",
          writable: true,
        },
      },
      messaging: {
        enabled: {
          value: true,
          source: "default",
        },
        allowFullAccessEscalation: {
          value: true,
          source: "default",
        },
        allowFullAccessThreadResume: {
          value: true,
          source: "default",
        },
        fullAccessWarning: {
          value: "dismissable",
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
        managerToolUpdateMode: {
          value: "show_none",
          source: "default",
        },
        showStreamingOption: { value: false, source: "default" },
        attachments: {
          imageProfile: { value: "medium", source: "default" },
          pdfProfile: { value: "high", source: "default" },
          maxAttachmentBytes: { value: 10485760, source: "default" },
          maxAttachmentCount: { value: 4, source: "default" },
        },
        telegram: {
          enabled: { value: true, source: "config" },
          responseMode: { value: "every_message", source: "default" },
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
          liveWorkingCards: { value: false, source: "default" },
          responseMode: { value: "mention_only", source: "default" },
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
          teamAuthorizationMode: { value: "approved_only", source: "default" },
          channelAuthorizationMode: { value: "approved_only", source: "default" },
          dmAccessMode: { value: "authorized_users", source: "default" },
          groupDmAccessMode: { value: "none", source: "default" },
          channelUserAccessMode: { value: "authorized_users", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedWorkspaces: { value: [], source: "default" },
          authorizedChannels: { value: [], source: "default" },
        },
        feishu: {
          enabled: { value: false, source: "default" },
          streamingResponses: { value: false, source: "default" },
          appId: { configured: false, source: "unset", writable: true },
          appSecret: { configured: false, source: "unset", writable: true },
          encryptKey: { configured: false, source: "unset", writable: true },
          verificationToken: { configured: false, source: "unset", writable: true },
          inboundMode: { value: "persistent", source: "default" },
          tenantRegion: { value: "feishu", source: "default" },
          tenantUrl: { value: "", source: "default" },
          callbackBaseUrl: { value: "", source: "default" },
          slashCommandPrefix: { value: "pwragent_", source: "default" },
          registerSlashCommands: { value: false, source: "default" },
          authorizedUserIds: { value: [], source: "default" },
          authorizedChats: { value: [], source: "default" },
          authorizedTenants: { value: [], source: "default" },
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
        providerDefaults: {},
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
      },
      acpAgents: {
        gemini: {
          cliPath: { value: "", source: "default" },
          enabled: true,
        },
        grok: {
          cliPath: { value: "", source: "default" },
          enabled: true,
        },
        kimi: {
          cliPath: { value: "", source: "default" },
          enabled: true,
        },
        qwen: {
          cliPath: { value: "", source: "default" },
          enabled: true,
        },
      },
      git: {
        backgroundPrPolling: { value: true, source: "default" },
        prAutoDispatchAllowed: { value: true, source: "default" },
        defaultPrAutoDispatchEnabled: { value: true, source: "default" },
        prAutoDispatchBudgetCapacity: { value: 30, source: "default" },
        prAutoDispatchBudgetRefillPerMinute: {
          value: 1,
          source: "default",
        },
        pausePrAutoDispatchWhenBudgetEmpty: {
          value: true,
          source: "default",
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

describe("inferDesktopUpdateSelection", () => {
  it("maps website download versions onto the matching train and track", () => {
    expect(inferDesktopUpdateSelection("1.0.1")).toEqual({
      train: "stable",
      channel: "latest",
    });
    expect(inferDesktopUpdateSelection("1.0.1-prerelease.5")).toEqual({
      train: "stable",
      channel: "prerelease",
    });
    expect(inferDesktopUpdateSelection("1.1.0-beta.2")).toEqual({
      train: "beta",
      channel: "latest",
    });
    expect(inferDesktopUpdateSelection("v1.1.0-alpha.7")).toEqual({
      train: "beta",
      channel: "prerelease",
    });
  });

  it("keeps historical 1.0.0-beta builds on Stable Latest", () => {
    expect(inferDesktopUpdateSelection("1.0.0-beta.50")).toEqual({
      train: "stable",
      channel: "latest",
    });
  });
});
