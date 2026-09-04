import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AcpAgentSettingsEntry,
  AgentEvent,
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  BackendSummary,
  DesktopSettingsSnapshot,
  InspectDiscordThreadPermissionsResponse,
  ListMessagingRoutesResponse,
  MessagingPairingEntry,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { SettingsScreen } from "../SettingsScreen";
import type { DesktopSettingsState } from "../useDesktopSettings";

const originalScrollTo = window.scrollTo;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "scrollX", {
    configurable: true,
    value: 0,
  });
  Object.defineProperty(window, "scrollY", {
    configurable: true,
    value: 0,
  });
  Object.defineProperty(window, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  vi.restoreAllMocks();
});

/**
 * The Experimental tab tucks its deprecated features (Diff Condensation,
 * Live Transcript Event Filtering) inside a collapsed-by-
 * default "Soon to be discontinued" drawer, where they are hidden from the
 * accessibility tree until expanded. Idempotent (checks `aria-expanded`) so
 * it is safe regardless of the drawer's persisted collapse state from a
 * prior test in this file.
 */
function openDiscontinuedDrawer() {
  const header = screen.getByRole("button", {
    name: "Soon to be discontinued",
  });
  if (header.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(header);
  }
}

function createSnapshot(
  overrides: Partial<DesktopSettingsSnapshot> = {},
): DesktopSettingsSnapshot {
  return {
    fetchedAt: 1,
    configPath: "/tmp/pwragent/config.toml",
    runtime: {
      messaging: {
        disabled: false,
      },
    },
    secretStorage: {
      available: true,
      backend: "memory",
      encrypted: false,
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
        outputCapHitsEnabled: { value: true, source: "config" },
        repeatedLargeOutputsEnabled: { value: true, source: "config" },
        repeatedLargeOutputMinimumCalls: { value: 5, source: "default" },
        repeatedLargeOutputMinimumPercent: { value: 50, source: "default" },
        repeatedQueuedChecksEnabled: { value: true, source: "config" },
      },
      spendAlerts: {
        activeTurnSpendEnabled: { value: true, source: "config" },
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
      markdownMathRendering: {
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
      tokenMiserEnabled: {
        value: false,
        source: "default",
      },
      tokenMiserDefaultEnabled: {
        value: true,
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
      selectionSource: "inferred",
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
      listenPort: { value: 47830, source: "default" },
      publicUrl: { value: "", source: "default" },
      gatewayUrl: { value: "", source: "default" },
      gatewayEndpoints: { value: [], source: "default" },
      advertisedEndpoints: { value: [], source: "default" },
      cloudflareEndpoint: { value: "", source: "default" },
      cloudflareMtlsEnabled: { value: false, source: "default" },
      cloudflareAccessServiceAuthEnabled: {
        value: false,
        source: "default",
      },
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
      enabled: { value: true, source: "default" },
      allowFullAccessEscalation: { value: true, source: "default" },
      allowFullAccessThreadResume: { value: true, source: "default" },
      fullAccessWarning: { value: "dismissable", source: "default" },
      inputDebounceMs: { value: 500, source: "default" },
      toolUpdateMode: { value: "show_some", source: "default" },
      managerToolUpdateMode: { value: "show_none", source: "default" },
      showStreamingOption: { value: false, source: "default" },
      telegram: {
        enabled: { value: false, source: "default" },
        responseMode: { value: "every_message", source: "default" },
        streamingResponses: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        authorizedUserIds: { value: [], source: "default" },
        authorizedSupergroups: { value: [], source: "default" },
      },
      discord: {
        enabled: { value: false, source: "default" },
        responseMode: { value: "every_message", source: "default" },
        responseModeOverrides: { value: [], source: "default" },
        streamingResponses: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        applicationId: { value: "", source: "default" },
        authorizedUserIds: { value: [], source: "default" },
        authorizedGuilds: { value: [], source: "default" },
      },
      mattermost: {
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
      },
      slack: {
        enabled: { value: false, source: "default" },
        liveWorkingCards: { value: false, source: "default" },
        responseMode: { value: "mention_only", source: "default" },
        streamingResponses: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        appToken: { configured: false, source: "unset", writable: true },
        signingSecret: { configured: false, source: "unset", writable: true },
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
        channelAccessToken: { configured: false, source: "unset", writable: true },
        channelSecret: { configured: false, source: "unset", writable: true },
        webhookUrl: { value: "", source: "default" },
        callbackBaseUrl: { value: "", source: "default" },
        botUserId: { value: "", source: "default" },
        authorizedUserIds: { value: [], source: "default" },
        authorizedGroups: { value: [], source: "default" },
        authorizedRooms: { value: [], source: "default" },
      },
      attachments: {
        imageProfile: { value: "medium", source: "default" },
        pdfProfile: { value: "high", source: "default" },
        maxAttachmentBytes: { value: 10485760, source: "default" },
        maxAttachmentCount: { value: 4, source: "default" },
      },
    },
    models: {
      codex: {
        path: { value: "", source: "default" },
        profile: { value: "", source: "default" },
        discovery: {
          selectedCommand: "/usr/local/bin/codex",
          selectedSource: "path",
          candidates: [
            {
              command: "/usr/local/bin/codex",
              executable: true,
              selected: true,
              source: "path",
              version: "0.130.0",
            },
            {
              command: "/Applications/Codex.app/Contents/Resources/codex",
              executable: true,
              selected: false,
              source: "application",
              version: "0.120.0",
            },
          ],
        },
        profiles: {
          profileRoot: "/home/example/.codex/profiles",
          effectiveCodexHome: "/home/example/.codex",
          profiles: [
            {
              name: "",
              displayName: "System default",
              codexHome: "/home/example/.codex",
              source: "default",
              exists: true,
              selected: true,
              hasAuthFile: true,
              hasConfigFile: true,
            },
            {
              name: "work",
              displayName: "work",
              codexHome: "/home/example/.codex/profiles/work",
              accountEmail: "work@example.com",
              source: "directory",
              exists: true,
              selected: false,
              hasAuthFile: true,
              hasConfigFile: false,
            },
          ],
        },
      },
    },
    acpAgents: {
      gemini: { cliPath: { value: "", source: "default" }, enabled: true },
      grok: { cliPath: { value: "", source: "default" }, enabled: true },
      kimi: { cliPath: { value: "", source: "default" }, enabled: true },
      qwen: { cliPath: { value: "", source: "default" }, enabled: true },
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
      editors: [
        {
          id: "vscode",
          kind: "editor",
          name: "VS Code",
          source: "application",
          appPath: "/Applications/Visual Studio Code.app",
          iconDataUrl: "data:image/png;base64,editor",
          canOpenWorkspace: true,
        },
      ],
      terminals: [
        {
          id: "terminal",
          kind: "terminal",
          name: "Terminal",
          source: "application",
          appPath: "/System/Applications/Utilities/Terminal.app",
          iconDataUrl: "data:image/png;base64,terminal",
          canOpenWorkspace: true,
        },
        {
          id: "ghostty",
          kind: "terminal",
          name: "Ghostty",
          source: "application",
          appPath: "/Applications/Ghostty.app",
          iconDataUrl: "data:image/png;base64,terminal",
          canOpenWorkspace: true,
        },
      ],
      preferredEditorId: { value: "", source: "default" },
      preferredTerminalId: { value: "", source: "default" },
      gh: {
        path: { value: "", source: "default" },
        discovery: { candidates: [] },
      },
      git: {
        path: { value: "", source: "default" },
        discovery: {
          selectedCommand: "/opt/homebrew/bin/git",
          selectedSource: "homebrew",
          candidates: [
            {
              command: "/opt/homebrew/bin/git",
              source: "homebrew",
              executable: true,
              selected: true,
              version: "2.39.1",
            },
          ],
        },
      },
    },
    worktrees: {
      storage: { value: "user-home", source: "default" },
      effectivePath: "/home/example/.pwragent/worktrees",
    },
    ...overrides,
  };
}

function createSettingsState(
  snapshot = createSnapshot(),
): DesktopSettingsState {
  return {
    clearSecret: vi.fn(async () => true),
    composerImplementation: snapshot.experimental.chatReplyComposer.value,
    loading: false,
    refresh: vi.fn(async () => undefined),
    replaceSecret: vi.fn(async () => true),
    saving: false,
    snapshot,
    writeConfig: vi.fn(async () => true),
  };
}

describe("SettingsScreen segmented pending", () => {
  it("shows pending on a converted segmented group and clears it", async () => {
    let settleWrite!: () => void;
    const write = new Promise<boolean>((resolve) => {
      settleWrite = () => resolve(true);
    });
    const settings = createSettingsState();
    settings.writeConfig = vi.fn(() => write);

    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Worktrees" }));

    const group = screen.getByRole("radiogroup", {
      name: "Where should worktrees live?",
    });
    // The fixture already selects "User home", and re-picking the selected
    // segment is deliberately a no-op, so drive the one that actually changes.
    const inRepo = within(group).getByRole("radio", { name: "In repository" });
    fireEvent.click(inRepo);

    // The group was hand-rolled markup before the pending rollout reached it,
    // so this asserts the conversion actually wired the affordance rather
    // than only preserving the roles.
    await waitFor(() => {
      expect(document.querySelector(".settings-pending")).not.toBeNull();
    });
    expect(inRepo).toHaveAttribute("aria-busy", "true");
    expect(
      within(group).getByRole("radio", { name: "User home" }),
    ).not.toHaveAttribute("aria-busy");

    await act(async () => {
      settleWrite();
      await write;
    });

    expect(document.querySelector(".settings-pending")).toBeNull();
    expect(inRepo).not.toHaveAttribute("aria-busy");
  });

  it("ignores a re-click on the segment already selected", () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Worktrees" }));
    const group = screen.getByRole("radiogroup", {
      name: "Where should worktrees live?",
    });

    fireEvent.click(within(group).getByRole("radio", { name: "User home" }));

    expect(settings.writeConfig).not.toHaveBeenCalled();
    expect(document.querySelector(".settings-pending")).toBeNull();
  });

  it("leaves the appearance axes free of a pending affordance", () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "General" }));

    // Theme applies optimistically — the window re-themes on the click — so
    // this group shares the segmented markup but deliberately takes no
    // tracker. A spinner here would report a wait that already ended.
    const theme = screen.queryByRole("radiogroup", { name: "Theme" });
    if (theme) {
      fireEvent.click(within(theme).getAllByRole("radio")[0]!);
      expect(document.querySelector(".settings-pending")).toBeNull();
    }
  });
});

function createArchivedSnapshot(
  threadId: string,
  archivedAt: number,
): WorktreeSnapshotSummary {
  return {
    id: `snapshot-${threadId}-${archivedAt}`,
    backend: "codex",
    threadId,
    worktreePath: `/worktrees/${threadId}`,
    repositoryPath: "/repo/PwrAgnt",
    snapshotRef: `refs/archive/${threadId}`,
    snapshotCommit: "abc123",
    createdAt: archivedAt,
    archivedAt,
    state: "archived",
    ignoredFilesExcluded: true,
  };
}

describe("SettingsScreen", () => {
  it("renders cached provider models and keeps mount-only catalog reads passive", async () => {
    const cachedBackends: BackendSummary[] = [
      {
        kind: "codex",
        label: "OpenAI",
        available: true,
        methods: [],
        capabilities: {
          listThreads: true,
          createThread: true,
          resumeThread: true,
          renameThread: true,
          readThread: true,
          startTurn: true,
          interruptTurn: true,
          steerTurn: true,
          transcriptPagination: true,
          toolUse: true,
          approvalRequests: true,
          multiDirectoryThreads: true,
        },
        executionModes: [],
        launchpadOptions: {
          models: [
            {
              id: "gpt-5.6-sol",
              label: "GPT-5.6-Sol",
              supportsReasoning: true,
              reasoningEfforts: ["high", "xhigh"],
            },
          ],
        },
      },
    ];
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>(
      async () => await new Promise<never>(() => undefined),
    );
    const listAcpAgents = vi.fn<NonNullable<DesktopApi["listAcpAgents"]>>(async () => ({
      fetchedAt: 1000,
      entries: [
        {
          backendId: "acp:grok",
          registryId: "grok",
          name: "Grok",
          authors: ["xAI"],
          distributionKind: "local",
          distributionSource: "/usr/bin/grok",
          installable: false,
          installed: true,
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
          activeCommand: "/usr/bin/grok",
          instances: [
            { command: "/usr/bin/grok", version: "1.0.0", source: "path" },
            {
              command: "/opt/homebrew/bin/grok",
              version: "0.9.0",
              source: "path",
            },
          ],
        } satisfies AcpAgentSettingsEntry,
      ],
    }));

    render(
      <SettingsScreen
        cachedBackends={cachedBackends}
        desktopApi={{ listAcpAgents, listBackends }}
        initialSection="models"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("1 discovered model")).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("OpenAI default model")).getByRole("option", {
        name: "GPT-5.6-Sol",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No provider has reported a model catalog yet."))
      .not.toBeInTheDocument();
    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledWith({
        includeUnavailable: true,
      });
    });
    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalled();
    });
    expect(
      listAcpAgents.mock.calls.every(([request]) => request?.refresh === false),
    ).toBe(true);
    expect(
      listBackends.mock.calls.every(
        ([request]) => request?.refreshModels === undefined,
      ),
    ).toBe(true);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Grok settings" }),
    );
    expect(await screen.findByLabelText("Grok manual path")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      within(screen.getByLabelText("Grok installs")).getByRole("button", {
        name: "Use",
      }),
    ).toBeDisabled();
  });

  it("locks catalog refresh while settings are saving", async () => {
    const listBackends = vi.fn(async () => ({
      fetchedAt: 1000,
      backends: [],
    }));
    const settings = createSettingsState();
    settings.saving = true;

    render(
      <SettingsScreen
        desktopApi={{ listBackends }}
        initialSection="models"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Refresh all providers" }))
        .toBeDisabled();
    });
  });

  it("keeps the Models hub refresh explicitly all-provider", async () => {
    const listBackends = vi.fn(async () => ({
      fetchedAt: 1000,
      backends: [],
    }));
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [],
    }));

    render(
      <SettingsScreen
        desktopApi={{ listAcpAgents, listBackends }}
        initialSection="models"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const refresh = await screen.findByRole("button", {
      name: "Refresh all providers",
    });
    await waitFor(() => expect(listBackends).toHaveBeenCalled());
    listBackends.mockClear();
    listAcpAgents.mockClear();
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(listAcpAgents).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        force: true,
        refresh: true,
      });
      expect(listBackends).toHaveBeenCalledWith({
        discoveryIntent: "settings-user-action",
        includeUnavailable: true,
        refreshModels: true,
      });
    });
  });

  it("refreshes only Codex from the focused Codex screen", async () => {
    const listBackends = vi.fn<NonNullable<DesktopApi["listBackends"]>>(
      async () => ({ fetchedAt: 1000, backends: [] }),
    );
    const listAcpAgents = vi.fn<NonNullable<DesktopApi["listAcpAgents"]>>(
      async () => ({ fetchedAt: 1000, entries: [] }),
    );

    render(
      <SettingsScreen
        desktopApi={{ listAcpAgents, listBackends }}
        initialSection="models"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Codex" }));
    const refresh = await screen.findByRole("button", {
      name: "Refresh Codex",
    });
    await waitFor(() => expect(listBackends).toHaveBeenCalled());
    listBackends.mockClear();
    listAcpAgents.mockClear();
    fireEvent.click(refresh);

    await waitFor(() => {
      expect(listBackends).toHaveBeenCalledExactlyOnceWith({
        discoveryIntent: "settings-user-action",
        includeUnavailable: true,
        refreshModels: "codex",
      });
    });
    expect(listAcpAgents).not.toHaveBeenCalled();
  });

  it("names the active PwrAgent Codex path environment override", () => {
    const base = createSnapshot();
    const snapshot = createSnapshot({
      models: {
        ...base.models,
        codex: {
          ...base.models.codex,
          path: {
            value: "C:\\nvm4w\\nodejs\\codex.ps1",
            source: "env",
          },
        },
      },
    });

    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Codex path" })).toBeDisabled();
    expect(
      screen.getByText(
        "PWRAGENT_CODEX_COMMAND controls this path for the current process.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/PWRDRVR_CODEX_COMMAND/)).not.toBeInTheDocument();
  });

  it("commits an edited Codex path before an unrelated button action", async () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const codexPathInput = screen.getByRole("textbox", { name: "Codex path" });
    const generalButton = screen.getByRole("button", { name: "General" });
    fireEvent.change(codexPathInput, {
      target: { value: "C:\\nvm4w\\nodejs\\codex.ps1" },
    });
    fireEvent.blur(codexPathInput, { relatedTarget: generalButton });
    fireEvent.click(generalButton);

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          codex: {
            path: "C:\\nvm4w\\nodejs\\codex.ps1",
          },
        },
      });
    });
  });

  it("clamps accidental document scroll while mounted", async () => {
    Object.defineProperty(window, "scrollX", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(window, "scrollY", {
      configurable: true,
      value: 1481,
    });
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", {
      configurable: true,
      value: scrollTo,
    });
    const desktopApi = {
      logRendererDiagnostic: vi.fn(async () => undefined),
    };

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 0));
    expect(desktopApi.logRendererDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        message: "Settings document scroll clamped.",
        details: expect.objectContaining({
          scrollX: 0,
          scrollY: 1481,
        }),
      }),
    );
  });

  it("keeps every section row inside the scrolling lane and the chrome outside it", () => {
    // Regression guard for the clipped nav. `.settings-nav` is
    // `overflow: hidden`, so a section row rendered as a direct child of
    // the nav does not scroll — it is painted below the clip and no
    // pointer can reach it. At the 640px MAIN_WINDOW_MIN_HEIGHT that was
    // the whole tail of the list (Experimental, Troubleshooting, About).
    //
    // jsdom has no layout, so this cannot assert the geometry; what it
    // can pin is the structural invariant the geometry rests on — every
    // row inside the lane, and the masthead + Exit deliberately outside
    // it so they stay put while the list scrolls under them.
    const { container } = render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = container.querySelector(".settings-nav");
    const lane = container.querySelector(".settings-nav__sections");
    expect(nav).not.toBeNull();
    expect(lane).not.toBeNull();

    // Every scrolling part, not just the rows: the collapsible sublists and
    // the divider come out of the same map, and a refactor that hoisted the
    // sublists out — to stop the scroller clipping them, say — would leave a
    // rows-only assertion green while group children stopped scrolling with
    // their parent row.
    for (const selector of [
      ".settings-nav__row",
      ".settings-nav__sublist",
      ".settings-nav__divider",
    ]) {
      const members = [...container.querySelectorAll(selector)];
      expect(members.length).toBeGreaterThan(0);
      for (const member of members) {
        expect(lane?.contains(member)).toBe(true);
      }
    }

    // The pinned chrome is a sibling of the lane, not a passenger in it.
    for (const selector of [".settings-nav__masthead", ".settings-nav__exit"]) {
      const chrome = container.querySelector(selector);
      expect(chrome).not.toBeNull();
      expect(chrome?.parentElement).toBe(nav);
    }
  });

  it("switches sections and saves settings", async () => {
    const settings = createSettingsState();
    const desktopApi = {
      checkForAppUpdates: vi.fn(async () => ({
        status: "available" as const,
        version: "1.0.0-beta.8",
      })),
      readAppUpdateReleaseVersions: vi.fn(async () => ({
        fetchedAt: 1,
        stable: {
          latest: { version: "v1.0.0" },
          prerelease: { version: "v1.0.0-beta.7" },
        },
        beta: {
          latest: { version: "v1.1.0-beta.2" },
          prerelease: { version: "v1.1.0-alpha.7" },
        },
      })),
    };
    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(sections).getByRole("button", { name: "General" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    expect(screen.getByRole("heading", { name: "Updates" })).toBeInTheDocument();
    expect(
      await screen.findByRole("radio", { name: "Stable Latest — v1.0.0" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("switch", {
        name: "Confirm quit when threads or terminals are active",
      }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Confirm quit when threads or terminals are active",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          confirmQuitWithInProgressThreads: false,
        },
      });
    });
    expect(
      screen.getByRole("switch", {
        name: "Move a thread to the top when its turn finishes",
      }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Move a thread to the top when its turn finishes",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          attentionPromoteOnTurnEnd: false,
        },
      });
    });
    expect(
      screen.getByRole("switch", { name: "Use PwrAgent PDF analysis" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      screen.getByRole("switch", { name: "Use PwrAgent PDF analysis" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          pdfAnalysisEnabled: false,
        },
      });
    });
    expect(
      screen.queryByRole("switch", { name: "Developer Mode" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(sections).getByRole("button", { name: "Troubleshooting" }),
    );
    expect(
      screen.getByRole("heading", { name: "Chrome DevTools" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "CPU and heap monitoring" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Developer Mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(
      screen.getByRole("button", { name: "Start Capture (Immediate)" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Developer Mode" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          developerMode: true,
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Start Capture (Immediate)" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          hotCpuProfilingEnabled: true,
        },
      });
    });

    // "5 seconds" appears in both the profiling-start-delay and the
    // heap-snapshot-delay groups, so scope to the group under test.
    expect(
      within(
        screen.getByRole("radiogroup", { name: "Profiling start delay" }),
      ).getByRole("radio", { name: /5 seconds/ }),
    ).not.toBeDisabled();
    expect(screen.getByRole("radio", { name: /Slowburn/ })).not.toBeDisabled();
    expect(
      screen.getByRole("switch", { name: "Smart heap snapshots" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: /2 snapshots/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /3 snapshots/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Smart heap snapshots" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          hotCpuProfilingCaptureHeapSnapshot: true,
        },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "General" }));
    expect(
      screen.getByRole("switch", { name: "Desktop notifications" }),
    ).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "Desktop notifications" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          notificationsEnabled: true,
        },
      });
    });

    expect(await screen.findByText("v1.0.0-beta.7")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Stable Latest — v1.0.0" }),
    ).toHaveAttribute("aria-checked", "true");
    // One tile, both axes — the two-control shape needed two clicks and two
    // writes to reach a slot, and each write had to re-send the axis the
    // operator had not touched.
    fireEvent.click(
      screen.getByRole("radio", { name: "Beta Latest — v1.1.0-beta.2" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        updates: {
          train: "beta",
          channel: "latest",
        },
      });
    });
    fireEvent.click(
      screen.getByRole("radio", { name: "Stable Prerelease — v1.0.0-beta.7" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        updates: {
          channel: "prerelease",
          train: "stable",
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for Update" }));
    await waitFor(() => {
      expect(desktopApi.checkForAppUpdates).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/Update available: v1.0.0-beta.8/),
    ).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Pasted images" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "1536 patches" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "4096 patches" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        imageUploads: {
          pastedImageMaxPatches: 4096,
        },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Applications" }));
    expect(screen.getByRole("heading", { name: "Editor" })).toBeInTheDocument();
    expect(screen.getByText("VS Code")).toBeInTheDocument();
    expect(screen.getByText("/Applications/Visual Studio Code.app")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Terminal" })).toBeInTheDocument();
    expect(screen.getAllByText("Terminal").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("/System/Applications/Utilities/Terminal.app")).toBeInTheDocument();
    expect(screen.getByText("Ghostty")).toBeInTheDocument();
    expect(screen.getByText("/Applications/Ghostty.app")).toBeInTheDocument();
    // Applications is the inventory of every external program PwrAgent
    // runs, so the two command line tools render here as well as on Git —
    // the same components over the same config keys, not a copy.
    expect(
      screen.getByRole("heading", { name: "GitHub CLI (gh)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Git" })).toBeInTheDocument();

    // The whole row is the control, so its accessible name names the
    // choice rather than repeating a bare "Use".
    fireEvent.click(
      screen.getByRole("button", {
        name: "Use Ghostty at /Applications/Ghostty.app",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        applications: {
          terminal: {
            preferredId: "ghostty",
          },
        },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Git" }));
    expect(
      screen.getByRole("heading", { name: "Repository & pull requests" }),
    ).toBeInTheDocument();

    // The Git setting defaults on when the config does not opt out.
    const backgroundPrPollingSwitch = screen.getByRole("switch", {
      name: "Enable background pull request status",
    });
    expect(backgroundPrPollingSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(backgroundPrPollingSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { backgroundPrPolling: false },
      });
    });

    fireEvent.click(
      within(sections).getByRole("button", { name: "Usage & Pricing" }),
    );
    expect(
      screen.getByRole("heading", { name: "Usage & pricing" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Alerts" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Repeated large tool outputs" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByText(/This trigger does not use the calls-per-turn setting/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Cap-hit alerts remain immediate/),
    ).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("spinbutton", {
        name: "Active turn spend threshold",
      }),
      { target: { value: "7.50" } },
    );
    fireEvent.blur(
      screen.getByRole("spinbutton", {
        name: "Active turn spend threshold",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          spendAlerts: {
            activeTurnSpendThresholdUsd: 7.5,
          },
        },
      });
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Total thread spend" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          spendAlerts: {
            threadSpendEnabled: false,
          },
        },
      });
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Calls per turn" }), {
      target: { value: "7" },
    });
    fireEvent.blur(screen.getByRole("spinbutton", { name: "Calls per turn" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          toolOutputAlerts: {
            repeatedLargeOutputMinimumCalls: 7,
          },
        },
      });
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Output size threshold" }),
      { target: { value: "65" } },
    );
    fireEvent.blur(
      screen.getByRole("spinbutton", { name: "Output size threshold" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          toolOutputAlerts: {
            repeatedLargeOutputMinimumPercent: 65,
          },
        },
      });
    });
    fireEvent.click(
      screen.getByRole("switch", { name: "Repeated large tool outputs" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          toolOutputAlerts: {
            repeatedLargeOutputsEnabled: false,
          },
        },
      });
    });
    fireEvent.click(
      screen.getByRole("switch", {
        name: "Show thread pricing",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { threadPricingSummary: false },
      });
    });
    expect(
      screen.getByRole("button", { name: "List Price" }),
    ).not.toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Codex Credits" }),
    ).not.toBeDisabled();

    fireEvent.click(within(sections).getByRole("button", { name: "Experimental" }));
    const tokenMiserSwitch = screen.getByRole("switch", {
      name: "Make Token Miser available",
    });
    expect(tokenMiserSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(tokenMiserSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { tokenMiserEnabled: true },
      });
    });
    expect(screen.queryByRole("radiogroup", { name: "Chat Reply Composer" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", {
        name: "Enable background pull request status",
      }),
    ).not.toBeInTheDocument();
    openDiscontinuedDrawer();
    expect(
      screen.getByText(
        "Send focused-diff hunks to Codex GPT-5.6 Luna to decide which are safe to hide. Disabled by default — every diff renders in full and no structured-generation request fires.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Enable diff condensation" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { diffCondensation: { enabled: true } },
      });
    });

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Enable live transcript event filtering",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { liveTranscriptEventFiltering: true },
      });
    });

    expect(
      screen.getByRole("switch", { name: "Display tool call tracking" }),
    ).not.toBeDisabled();
    expect(
      screen.queryByRole("heading", { name: "Thread pricing" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Enable lightweight navigation refresh",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { lightweightNavigationRefresh: true },
      });
    });

    fireEvent.click(
      screen.getByRole("switch", {
        name: "Enable Codex skill questions",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { codexDefaultModeRequestUserInput: true },
      });
    });

    const managedReviewSwitch = screen.getByRole("switch", {
      name: "Enable managed code review",
    });
    expect(managedReviewSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(managedReviewSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { managedReview: true },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    const imageProfile = screen.getByRole("radiogroup", {
      name: "Inbound image profile",
    });
    expect(within(imageProfile).getByRole("radio", { name: "Medium" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(imageProfile).getByRole("radio", { name: "High" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          attachments: {
            imageProfile: "high",
          },
        },
      });
    });
    const pdfProfile = screen.getByRole("radiogroup", {
      name: "Inbound PDF render profile",
    });
    expect(within(pdfProfile).getByRole("radio", { name: "High" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(within(pdfProfile).getByRole("radio", { name: "Maximum" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          attachments: {
            pdfProfile: "actual",
          },
        },
      });
    });
    const developmentWorkingUpdates = screen.getByRole("radiogroup", {
      name: "Development thread Working Updates",
    });
    expect(
      within(developmentWorkingUpdates).getByRole("radio", { name: "Show Some" }),
    ).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(
      within(developmentWorkingUpdates).getByRole("radio", { name: "Show All" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          toolUpdateMode: "show_all",
        },
      });
    });
    const managerWorkingUpdates = screen.getByRole("radiogroup", {
      name: "Manager agent Working Updates",
    });
    expect(
      within(managerWorkingUpdates).getByRole("radio", { name: "Show None" }),
    ).toHaveAttribute("aria-checked", "true");
    fireEvent.click(
      within(managerWorkingUpdates).getByRole("radio", { name: "Show More" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          managerToolUpdateMode: "show_more",
        },
      });
    });
    expect(
      screen.queryByRole("radiogroup", {
        name: "Agent route Working Updates",
      }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Input debounce"), {
      target: { value: "750" },
    });
    fireEvent.blur(screen.getByLabelText("Input debounce"));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          inputDebounceMs: 750,
        },
      });
    });
    // Platforms live behind the hub's index now — each opens a focused
    // screen with the platform's full section.
    fireEvent.click(
      screen.getByRole("button", { name: "Open Telegram settings" }),
    );
    expect(
      screen.getByRole("heading", { level: 2, name: "Telegram" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Authorized Groups / Supergroups")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Group/supergroup chat" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText("unset").length).toBeGreaterThanOrEqual(1);
    fireEvent.click(
      screen.getByRole("switch", { name: "Streaming Responses (Advanced)" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            streamingResponses: true,
          },
        },
      });
    });
    // Turning on a provider's streaming arms the thread-card nudge, and
    // the panel renders on the focused screen where it was earned — it
    // used to render only inside the hub's General section, which the
    // focused screens never show.
    expect(
      screen.getByRole("button", { name: "Show it on thread cards" }),
    ).toBeInTheDocument();
    // The focused screen's General strip leads back to the hub.
    fireEvent.click(screen.getByRole("button", { name: "Edit general" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Slack settings" }));
    expect(
      screen.getByText(
        "Shows Working Updates in one Slack task card per turn when Slack stream APIs are available; otherwise uses text updates.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("switch", { name: "Live Working Updates card" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            liveWorkingCards: true,
          },
        },
      });
    });
    // Slack's streaming toggle carries its own label (no "(Advanced)"
    // suffix) and writes a Slack-scoped delta.
    fireEvent.click(
      screen.getByRole("switch", { name: "Streaming responses" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            streamingResponses: true,
          },
        },
      });
    });
    // Discord, Mattermost, and Feishu each carry the advanced streaming
    // toggle on their focused screens and write per-platform deltas.
    for (const [platform, label] of [
      ["discord", "Discord"],
      ["mattermost", "Mattermost"],
      ["feishu", "Feishu / Lark"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Edit general" }));
      fireEvent.click(
        screen.getByRole("button", { name: `Open ${label} settings` }),
      );
      fireEvent.click(
        screen.getByRole("switch", { name: "Streaming Responses (Advanced)" }),
      );
      await waitFor(() => {
        expect(settings.writeConfig).toHaveBeenCalledWith({
          messaging: {
            [platform]: {
              streamingResponses: true,
            },
          },
        });
      });
    }
    // LINE has no message-edit API, so its screen deliberately has no
    // streaming toggle.
    fireEvent.click(screen.getByRole("button", { name: "Edit general" }));
    fireEvent.click(screen.getByRole("button", { name: "Open LINE settings" }));
    expect(
      screen.queryByRole("switch", { name: "Streaming Responses (Advanced)" }),
    ).not.toBeInTheDocument();

    fireEvent.click(within(sections).getByRole("button", { name: "AI Providers" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Codex settings" }));
    expect(
      screen.getByRole("heading", { level: 2, name: "Codex" }),
    ).toBeInTheDocument();
    // The selected command appears in two places now: the pathrow
    // list (Codex discovery candidates) AND the SettingsTestBlock's
    // default name (it shows the path the Test button would invoke).
    // Both are correct.
    expect(screen.getAllByText("/usr/local/bin/codex").length).toBeGreaterThanOrEqual(2);
    const codexPathInput = screen.getByRole("textbox", { name: "Codex path" });
    expect(codexPathInput).toBeEnabled();
    fireEvent.change(codexPathInput, {
      target: { value: "C:\\nvm4w\\nodejs\\codex.ps1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save path" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          codex: {
            path: "C:\\nvm4w\\nodejs\\codex.ps1",
          },
        },
      });
    });
    expect(screen.getByText("0.130.0")).toBeInTheDocument();
    // Source pills on the Codex fields show the effective config
    // source (the redundant `Using /path/to/binary` label was
    // dropped — the path is already visible in the pathrow list
    // via the "Using" chip below). With the seed data
    // codex.path.source === "default" → label "auto".
    expect(screen.getAllByText("auto").length).toBeGreaterThanOrEqual(2);

    // Codex pathrow only renders a "Use" button on candidates that
    // are NOT currently selected (the selected one shows a "Using"
    // chip instead).
    const useButtons = screen.getAllByRole("button", { name: "Use" });
    expect(useButtons).toHaveLength(2);
    fireEvent.click(useButtons[0]!);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          codex: {
            path: "/Applications/Codex.app/Contents/Resources/codex",
          },
        },
      });
    });
    expect(screen.getAllByText("System default").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("/home/example/.codex/profiles/work")).toBeInTheDocument();
    expect(screen.getByText("work@example.com")).toBeInTheDocument();
    fireEvent.click(useButtons[1]!);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          codex: {
            profile: "work",
          },
        },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Worktrees" }));
    expect(screen.getByRole("heading", { name: "Storage location" })).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "User home" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "In repository" }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("/home/example/.pwragent/worktrees")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "In repository" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        worktrees: { storage: "in-repo" },
      });
    });

    fireEvent.click(
      within(sections).getByRole("button", { name: "Archived Threads" }),
    );
    expect(screen.getByRole("heading", { name: "Archived threads" })).toBeInTheDocument();

    fireEvent.click(within(sections).getByRole("button", { name: "General" }));
    expect(within(sections).getByRole("button", { name: "Experimental" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
  }, 15_000);

  it("resets bound Working Updates separately for Development threads and manager agents", async () => {
    const settings = createSettingsState();
    const listMessagingRoutes = vi.fn(async () => ({
      defaultAgents: [],
      bindings: [
        {
          bindingId: "development-binding",
          platform: "slack" as const,
          conversation: { id: "C1", kind: "channel" as const },
          target: {
            backend: "codex" as const,
            threadId: "thread-1",
            label: "Development work",
            kind: "thread" as const,
          },
          createdAt: 1,
          updatedAt: 1,
        },
        {
          bindingId: "manager-binding",
          platform: "slack" as const,
          conversation: { id: "C2", kind: "channel" as const },
          target: {
            backend: "codex" as const,
            threadId: "agent-1",
            label: "Queue manager",
            kind: "agent_thread" as const,
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      eligibleAgents: [],
      observedSurfaces: [],
    }));
    const resetMessagingToolUpdateBindings = vi.fn(async () => ({
      bindingCount: 1,
    }));

    render(
      <SettingsScreen
        desktopApi={{
          listMessagingRoutes,
          resetMessagingToolUpdateBindings,
        }}
        initialSection="messaging"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset bound Development thread bindings",
      }),
    );
    expect(
      await screen.findByText("Reset 1 bound Development thread binding?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset bindings" }));
    await waitFor(() => {
      expect(resetMessagingToolUpdateBindings).toHaveBeenCalledWith({
        targetKind: "thread",
      });
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Reset bound manager agent bindings",
      }),
    );
    expect(
      await screen.findByText("Reset 1 bound manager agent binding?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset bindings" }));
    await waitFor(() => {
      expect(resetMessagingToolUpdateBindings).toHaveBeenLastCalledWith({
        targetKind: "agent_thread",
      });
    });
  });

  it("saves the hot CPU heap snapshot limit when heap capture is armed", async () => {
    const baseSnapshot = createSnapshot();
    const settings = createSettingsState(
      createSnapshot({
        general: {
          ...baseSnapshot.general,
          hotCpuProfilingEnabled: { value: true, source: "config" },
          hotCpuProfilingCaptureHeapSnapshot: {
            value: true,
            source: "config",
          },
          hotCpuProfilingHeapSnapshotLimit: {
            value: 2,
            source: "config",
          },
        },
      }),
    );

    render(
      <SettingsScreen
        initialSection="troubleshooting"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("radio", { name: /3 snapshots/ })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /3 snapshots/ }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          hotCpuProfilingHeapSnapshotLimit: 3,
        },
      });
    });
  });

  it("copies Troubleshooting diagnostics with the profile, PIDs, and log path", async () => {
    const copyText = vi.fn(async () => undefined);

    render(
      <SettingsScreen
        desktopApi={{
          copyText,
          readAppMetadata: vi.fn(async () => ({
            applicationName: "PwrAgent",
            applicationVersion: "1.2.3",
            copyright: "Copyright © 2026 PwrDrvr LLC.",
            homepage: "https://pwragent.ai",
            documentationUrl: "https://docs.pwragent.ai",
            electronVersion: "41.2.1",
            chromeVersion: "142.0.0.0",
            nodeVersion: "24.0.0",
            mainProcessId: 4100,
            rendererProcessId: 4101,
            activeProfileName: "work",
            logFilePath:
              "/Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
            codexProfilePath: "/Users/operator/.codex/profiles/work",
          })),
        }}
        initialSection="troubleshooting"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Copy local diagnostics info",
      }),
    );

    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith([
        "PwrAgent profile: work",
        "Main process PID: 4100",
        "Renderer process PID: 4101",
        "PwrAgent log path: /Users/operator/Library/Logs/PwrAgent/profile-work.main.log",
      ].join("\n"));
    });
  });

  it("starts and stops a Codex protocol capture with copyable handoff details", async () => {
    const settings = createSettingsState();
    const captureFilePath = "/diagnostics/protocol-captures/snippet.jsonl";
    const getCodexProtocolCaptureStatus = vi.fn(async () => ({
      active: false as const,
      available: true,
    }));
    const startCodexProtocolCapture = vi.fn(async () => ({
      active: true as const,
      available: true as const,
      captureFilePath,
      startedAt: "2026-08-10T12:00:00.000Z",
    }));
    const stopCodexProtocolCapture = vi.fn(async () => ({
      captureFilePath,
      sizeBytes: 1536,
      startedAt: "2026-08-10T12:00:00.000Z",
      stoppedAt: "2026-08-10T12:00:05.000Z",
    }));
    const copyText = vi.fn(async () => undefined);
    const onShowNotice = vi.fn();

    render(
      <SettingsScreen
        desktopApi={{
          copyText,
          getCodexProtocolCaptureStatus,
          startCodexProtocolCapture,
          stopCodexProtocolCapture,
        }}
        initialSection="troubleshooting"
        onShowNotice={onShowNotice}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const startButton = await screen.findByRole("button", {
      name: "Start Protocol Capture",
    });
    expect(startButton).toBeEnabled();
    fireEvent.click(startButton);
    await waitFor(() => {
      expect(startCodexProtocolCapture).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop Protocol Capture" }),
    );
    await waitFor(() => {
      expect(stopCodexProtocolCapture).toHaveBeenCalledTimes(1);
      expect(onShowNotice).toHaveBeenCalledTimes(1);
    });

    const notice = onShowNotice.mock.calls[0]?.[0];
    expect(notice).toMatchObject({
      detail: captureFilePath,
      message: expect.stringContaining("Saved 1.5 KB"),
      title: "Codex protocol capture saved",
      tone: "success",
    });
    expect(screen.getByText(captureFilePath)).toBeInTheDocument();
    notice.actions[0].onClick();
    await waitFor(() => {
      expect(copyText).toHaveBeenCalledWith(
        expect.stringContaining(`Capture path: ${captureFilePath}`),
      );
    });
  });

  it("shows a copyable warning when protocol capture finalization is partial", async () => {
    const captureFilePath = "/diagnostics/protocol-captures/partial.jsonl";
    const onShowNotice = vi.fn();
    render(
      <SettingsScreen
        desktopApi={{
          getCodexProtocolCaptureStatus: vi.fn(async () => ({
            active: true as const,
            available: true as const,
            captureFilePath,
            startedAt: "2026-08-10T12:00:00.000Z",
          })),
          startCodexProtocolCapture: vi.fn(),
          stopCodexProtocolCapture: vi.fn(async () => ({
            captureFilePath,
            finalizationError: "Capture size could not be read.",
            startedAt: "2026-08-10T12:00:00.000Z",
            stoppedAt: "2026-08-10T12:00:05.000Z",
          })),
        }}
        initialSection="troubleshooting"
        onShowNotice={onShowNotice}
        settings={createSettingsState()}
      />,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Stop Protocol Capture" }),
    );
    await waitFor(() => {
      expect(onShowNotice).toHaveBeenCalledTimes(1);
    });
    expect(onShowNotice.mock.calls[0]?.[0]).toMatchObject({
      detail: captureFilePath,
      message: expect.stringContaining("Size unavailable"),
      title: "Codex protocol capture stopped with warning",
      tone: "warning",
    });
    expect(
      screen.getByText(/Finalization reported a warning/),
    ).toBeInTheDocument();
  });

  it("saves thread pricing display chips", async () => {
    const baseSnapshot = createSnapshot();
    const settings = createSettingsState(
      createSnapshot({
        experimental: {
          ...baseSnapshot.experimental,
          threadPricingSummary: { value: true, source: "config" },
          threadPricingDisplayUsd: { value: true, source: "default" },
          threadPricingDisplayCodexCredits: { value: false, source: "default" },
          threadToolAccounting: { value: false, source: "default" },
        },
      }),
    );

    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Usage & Pricing" }));

    expect(
      screen.getByText(
        "List Price uses each provider's published rates. Codex Credits use Codex's token-based credit rate card.",
      ),
    ).toBeInTheDocument();
    const listPriceChip = screen.getByRole("button", { name: "List Price" });
    const creditsChip = screen.getByRole("button", { name: "Codex Credits" });
    expect(listPriceChip).toHaveAttribute("aria-pressed", "true");
    expect(creditsChip).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(listPriceChip);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { threadPricingDisplayUsd: false },
      });
    });

    fireEvent.click(creditsChip);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { threadPricingDisplayCodexCredits: true },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Experimental" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Display tool call tracking" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { threadToolAccounting: true },
      });
    });
  });

  it("disables pricing units but keeps tool accounting independent", () => {
    const baseSnapshot = createSnapshot();
    const settings = createSettingsState(
      createSnapshot({
        experimental: {
          ...baseSnapshot.experimental,
          threadPricingSummary: { value: false, source: "config" },
          threadPricingDisplayUsd: { value: true, source: "default" },
          threadPricingDisplayCodexCredits: { value: false, source: "default" },
          threadToolAccounting: { value: false, source: "default" },
        },
      }),
    );

    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Usage & Pricing" }));

    expect(screen.getByRole("button", { name: "List Price" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Codex Credits" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Experimental" }));
    expect(
      screen.getByRole("switch", { name: "Display tool call tracking" }),
    ).toBeEnabled();
  });

  it("saves hot CPU profiling delay and trigger mode presets", async () => {
    const baseSnapshot = createSnapshot();
    const settings = createSettingsState(
      createSnapshot({
        general: {
          ...baseSnapshot.general,
          hotCpuProfilingEnabled: { value: true, source: "config" },
        },
      }),
    );

    render(
      <SettingsScreen
        initialSection="troubleshooting"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(
      within(
        screen.getByRole("radiogroup", { name: "Profiling start delay" }),
      ).getByRole("radio", { name: /5 seconds/ }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          hotCpuProfilingStartDelayMs: 5000,
        },
      });
    });

    fireEvent.click(screen.getByRole("radio", { name: /Slowburn/ }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          hotCpuProfilingTriggerMode: "slowburn",
        },
      });
    });
  });

  it("defaults missing experimental flags off and persists each when enabled", async () => {
    const snapshot = createSnapshot();
    const experimental = snapshot.experimental as Partial<
      typeof snapshot.experimental
    >;
    delete experimental.liveTranscriptEventFiltering;
    delete experimental.codexDefaultModeRequestUserInput;
    delete experimental.lightweightNavigationRefresh;
    delete experimental.markdownMathRendering;
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        initialSection="experimental"
        settings={settings}
      />,
    );

    openDiscontinuedDrawer();
    const filteringSwitch = screen.getByRole("switch", {
      name: "Enable live transcript event filtering",
    });
    const questionsSwitch = screen.getByRole("switch", {
      name: "Enable Codex skill questions",
    });
    const refreshSwitch = screen.getByRole("switch", {
      name: "Enable lightweight navigation refresh",
    });
    const mathSwitch = screen.getByRole("switch", {
      name: "Enable Markdown math rendering",
    });

    expect(filteringSwitch).toHaveAttribute("aria-checked", "false");
    expect(questionsSwitch).toHaveAttribute("aria-checked", "false");
    expect(refreshSwitch).toHaveAttribute("aria-checked", "false");
    expect(mathSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(filteringSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { liveTranscriptEventFiltering: true },
      });
    });

    fireEvent.click(questionsSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { codexDefaultModeRequestUserInput: true },
      });
    });

    fireEvent.click(refreshSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { lightweightNavigationRefresh: true },
      });
    });

    fireEvent.click(mathSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { markdownMathRendering: true },
      });
    });
  });

  it("lists archived threads and restores one", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Archived code review",
      titleSource: "explicit",
      summary: "Needs to come back to the active thread list.",
      createdAt: 1_000,
      updatedAt: 2_000,
      linkedDirectories: [
        {
          id: "directory-1",
          label: "PwrAgnt",
          path: "/repo/PwrAgnt",
          kind: "local",
        },
      ],
      gitBranch: "feature/archive-settings",
      source: "codex",
    };
    const listThreads = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 3_000,
      threads: [archivedThread],
    }));
    const restoreThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-archived",
      restoredAt: 4_000,
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads, restoreThread }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("Archived code review")).toBeInTheDocument();
    expect(
      screen.getByText("Needs to come back to the active thread list."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "PwrAgnt" })).toBeInTheDocument();
    expect(screen.getByText("/repo/PwrAgnt")).toBeInTheDocument();
    expect(listThreads).toHaveBeenCalledWith({ archived: true });

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => {
      expect(restoreThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-archived",
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("Archived code review")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Restored Archived code review.")).toBeInTheDocument();
  });

  it("groups archived threads by project before restoration", async () => {
    const listThreads = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 3_000,
      threads: [
        {
          id: "thread-pwragent-2",
          title: "Second PwrAgent thread",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 4_000,
          worktreeSnapshots: [
            createArchivedSnapshot("thread-pwragent-2", 2_000),
          ],
          linkedDirectories: [
            {
              id: "directory-1",
              label: "PwrAgnt",
              path: "/repo/PwrAgnt",
              kind: "local" as const,
            },
          ],
          source: "codex" as const,
        },
        {
          id: "thread-other",
          title: "Other project thread",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 3_000,
          worktreeSnapshots: [createArchivedSnapshot("thread-other", 3_000)],
          linkedDirectories: [
            {
              id: "directory-2",
              label: "OtherProject",
              path: "/repo/OtherProject",
              kind: "local" as const,
            },
          ],
          source: "codex" as const,
        },
        {
          id: "thread-pwragent-1",
          title: "First PwrAgent thread",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 2_000,
          worktreeSnapshots: [
            createArchivedSnapshot("thread-pwragent-1", 5_000),
          ],
          linkedDirectories: [
            {
              id: "directory-1",
              label: "PwrAgnt",
              path: "/repo/PwrAgnt",
              kind: "local" as const,
            },
          ],
          source: "codex" as const,
        },
      ],
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    const pwrAgentGroup = (await screen.findByRole("heading", {
      name: "PwrAgnt",
    })).closest("section")!;
    expect(within(pwrAgentGroup).getByText("2 threads")).toBeInTheDocument();
    const firstPwrAgentThread = within(pwrAgentGroup).getByText(
      "First PwrAgent thread",
    );
    const secondPwrAgentThread = within(pwrAgentGroup).getByText(
      "Second PwrAgent thread",
    );
    expect(
      firstPwrAgentThread.compareDocumentPosition(secondPwrAgentThread) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const otherGroup = screen.getByRole("heading", {
      name: "OtherProject",
    }).closest("section")!;
    expect(within(otherGroup).getByText("1 thread")).toBeInTheDocument();
    expect(
      within(otherGroup).getByText("Other project thread"),
    ).toBeInTheDocument();
  });

  it("groups corrupted managed-worktree paths by project folder name", async () => {
    const listThreads = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 3_000,
      threads: [
        {
          id: "thread-pwrsnap-1",
          title: "Testing env setup",
          titleSource: "explicit" as const,
          archivedAt: 5_000,
          createdAt: 1_000,
          updatedAt: 2_000,
          linkedDirectories: [
            {
              id: "/Users/fixture-user/.codex/worktrees/mp7efuda/PwrSnap",
              label: "PwrSnap",
              path: "/Users/fixture-user/.codex/worktrees/mp7efuda/PwrSnap",
              worktreePath:
                "/Users/fixture-user/.codex/worktrees/mp7efuda/PwrSnap",
              kind: "worktree" as const,
            },
          ],
          source: "codex" as const,
        },
        {
          id: "thread-pwrsnap-2",
          title: "Popover window too tall",
          titleSource: "explicit" as const,
          archivedAt: 4_000,
          createdAt: 1_000,
          updatedAt: 2_000,
          linkedDirectories: [
            {
              id: "/Users/fixture-user/.codex/worktrees/mp32wplq/PwrSnap",
              label: "PwrSnap",
              path: "/Users/fixture-user/.codex/worktrees/mp32wplq/PwrSnap",
              worktreePath:
                "/Users/fixture-user/.codex/worktrees/mp32wplq/PwrSnap",
              kind: "worktree" as const,
            },
          ],
          source: "codex" as const,
        },
      ],
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    const pwrSnapGroup = (await screen.findByRole("heading", {
      name: "PwrSnap",
    })).closest("section")!;
    expect(within(pwrSnapGroup).getByText("2 threads")).toBeInTheDocument();
    expect(
      within(pwrSnapGroup).getByText("Testing env setup"),
    ).toBeInTheDocument();
    expect(
      within(pwrSnapGroup).getByText("Popover window too tall"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /mp7efuda/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /mp32wplq/ }),
    ).not.toBeInTheDocument();
  });

  it("groups active-profile scratch projects as Workspaces and hides inactive profile roots", async () => {
    const activeWorkspaceRoot = "/Users/fixture-user/.pwragent/profiles/dev/projects";
    const listThreads = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 3_000,
      workspaceRoots: [activeWorkspaceRoot],
      threads: [
        {
          id: "thread-dev-workspace-1",
          title: "lions roar",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 5_000,
          linkedDirectories: [
            {
              id: `${activeWorkspaceRoot}/2026-05-10-844f31`,
              label: "2026-05-10-844f31",
              path: `${activeWorkspaceRoot}/2026-05-10-844f31`,
              kind: "local" as const,
            },
          ],
          source: "codex" as const,
        },
        {
          id: "thread-dev-workspace-2",
          title: "what's up",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 4_000,
          projectKey: `${activeWorkspaceRoot}/2026-05-10-883761`,
          linkedDirectories: [],
          source: "codex" as const,
        },
        {
          id: "thread-legacy-workspace",
          title: "Key Lime Pie yum",
          titleSource: "explicit" as const,
          createdAt: 1_000,
          updatedAt: 3_000,
          linkedDirectories: [
            {
              id: "/Users/fixture-user/.pwragnt/projects",
              label: "projects",
              path: "/Users/fixture-user/.pwragnt/projects",
              kind: "local" as const,
            },
          ],
          source: "codex" as const,
        },
      ],
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    const workspacesGroup = (await screen.findByRole("heading", {
      name: "Workspaces",
    })).closest("section")!;
    expect(within(workspacesGroup).getByText("2 threads")).toBeInTheDocument();
    expect(within(workspacesGroup).getByText("lions roar")).toBeInTheDocument();
    expect(within(workspacesGroup).getByText("what's up")).toBeInTheDocument();
    expect(within(workspacesGroup).getByText(activeWorkspaceRoot)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "2026-05-10-844f31" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "2026-05-10-883761" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Key Lime Pie yum")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "projects" }),
    ).not.toBeInTheDocument();
  });

  it("limits each archived project to the 20 most recent archive timestamps", async () => {
    const listThreads = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 3_000,
      threads: Array.from({ length: 25 }, (_, index): AppServerThreadSummary => {
        const threadNumber = index + 1;
        const threadId = `thread-${threadNumber}`;
        return {
          id: threadId,
          title: `Archived thread ${String(threadNumber).padStart(2, "0")}`,
          titleSource: "explicit",
          createdAt: 1_000,
          updatedAt: 1_000 + threadNumber,
          worktreeSnapshots: [createArchivedSnapshot(threadId, threadNumber)],
          linkedDirectories: [
            {
              id: "directory-1",
              label: "PwrAgnt",
              path: "/repo/PwrAgnt",
              kind: "local",
            },
          ],
          source: "codex",
        };
      }),
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    const pwrAgentGroup = (await screen.findByRole("heading", {
      name: "PwrAgnt",
    })).closest("section")!;
    expect(
      within(pwrAgentGroup).getByText("Archived thread 25"),
    ).toBeInTheDocument();
    expect(
      within(pwrAgentGroup).getByText("Archived thread 06"),
    ).toBeInTheDocument();
    expect(
      within(pwrAgentGroup).queryByText("Archived thread 05"),
    ).not.toBeInTheDocument();
    expect(
      within(pwrAgentGroup).getByText(
        "Showing 20 of 25 most recent archived threads.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter archived threads"), {
      target: { value: "05" },
    });

    expect(
      within(pwrAgentGroup).getByText("Archived thread 05"),
    ).toBeInTheDocument();
    expect(
      within(pwrAgentGroup).queryByText("Archived thread 25"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 match")).toBeInTheDocument();
    expect(
      screen.getByText("Showing 1 matching archived thread in 1 project folder."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter archived threads"), {
      target: { value: "Archived" },
    });

    expect(screen.getByText("25 matches")).toBeInTheDocument();
    expect(
      screen.getByText("Showing 25 matching archived threads in 1 project folder."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Filter archived threads"), {
      target: { value: "not found" },
    });

    expect(
      screen.getByText("No archived threads match “not found”."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Showing 0 matching archived threads in 0 project folders."),
    ).not.toBeInTheDocument();
  });

  it("does not re-add a restored thread when a stale archive refresh resolves", async () => {
    const archivedThread: AppServerThreadSummary = {
      id: "thread-archived",
      title: "Archived code review",
      titleSource: "explicit",
      createdAt: 1_000,
      updatedAt: 2_000,
      linkedDirectories: [],
      source: "codex",
    };
    let resolveStaleRefresh:
      | ((response: AppServerListThreadsResponse) => void)
      | undefined;
    const listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        backend: "all" as const,
        fetchedAt: 3_000,
        threads: [archivedThread],
      })
      .mockImplementationOnce(
        () =>
          new Promise<AppServerListThreadsResponse>((resolve) => {
            resolveStaleRefresh = resolve;
          }),
      );
    const restoreThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-archived",
      restoredAt: 4_000,
    }));

    render(
      <SettingsScreen
        desktopApi={{ listThreads, restoreThread }}
        settings={createSettingsState()}
        initialSection="archived"
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("Archived code review")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(listThreads).toHaveBeenCalledTimes(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      expect(screen.queryByText("Archived code review")).not.toBeInTheDocument();
    });

    await act(async () => {
      resolveStaleRefresh?.({
        backend: "all",
        fetchedAt: 5_000,
        threads: [archivedThread],
      });
    });

    await waitFor(() => {
      expect(screen.queryByText("Archived code review")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Restored Archived code review.")).toBeInTheDocument();
  });

  it("shows ACP agents inside the consolidated AI Providers section", async () => {
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [],
      })),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="models"
        settings={createSettingsState()}
      />,
    );

    // Providers live under the "AI Providers" pane (no separate "ACP
    // Agents" nav item). The hub's index always lists Codex, and once
    // the catalog read settles with no agents it reports the settled
    // empty state — not the transient "Discovering…" copy.
    expect(
      screen.getByRole("button", { name: "AI Providers" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.queryByRole("button", { name: "ACP Agents" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Codex settings" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("No AI providers are available right now."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Discovering AI providers…"),
    ).not.toBeInTheDocument();
  });

  it("saves defaults and confirms launchpad, thread, and Fast bulk actions", async () => {
    const snapshot = createSnapshot();
    snapshot.models.providerDefaults = {
      codex: {
        model: "gpt-5.6-sol",
        reasoningEffortsByModel: {
          "gpt-5.6-sol": "high",
        },
      },
    };
    const settings = createSettingsState(snapshot);
    const updateDirectoryLaunchpad = vi.fn(async (request) => ({
      launchpad: {
        directoryKey: request.directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: "Repo",
        backend: "codex" as const,
        executionMode: "default" as const,
        workMode: "local" as const,
        prompt: "",
        model: request.patch.model,
        reasoningEffort: request.patch.reasoningEffort,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
        workMode: "local" as const,
        model: request.patch.model,
        reasoningEffort: request.patch.reasoningEffort,
      },
    }));
    const turnOffCodexFastEverywhere = vi.fn(async () => ({
      launchpadCount: 1,
      threadCount: 2,
    }));
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [],
      })),
      listBackends: vi.fn(async () => ({
        fetchedAt: 1000,
        backends: [
          {
            kind: "codex" as const,
            label: "Codex",
            available: true,
            methods: [],
            capabilities: {
              listThreads: true,
              createThread: true,
              resumeThread: true,
              renameThread: true,
              readThread: true,
              startTurn: true,
              interruptTurn: true,
              steerTurn: true,
              transcriptPagination: true,
              toolUse: true,
              approvalRequests: true,
              multiDirectoryThreads: true,
            },
            executionModes: [],
            launchpadOptions: {
              models: [
                {
                  id: "gpt-5.6-sol",
                  label: "GPT-5.6-Sol",
                  defaultReasoningEffort: "low",
                  reasoningEfforts: ["low", "high", "xhigh"],
                  supportsReasoning: true,
                },
                {
                  id: "gpt-5.6-terra",
                  label: "GPT-5.6-Terra",
                  supportsReasoning: true,
                },
                {
                  id: "gpt-5.5",
                  label: "GPT-5.5",
                  supportsReasoning: true,
                },
              ],
            },
          },
        ],
      })),
      getNavigationSnapshot: vi.fn(async () => ({
        fetchedAt: 1000,
        browseMode: "inbox" as const,
        directories: [
          {
            key: "directory:/repo-a",
            kind: "directory" as const,
            label: "Repo A",
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad: {
              directoryKey: "directory:/repo-a",
              directoryKind: "directory" as const,
              directoryLabel: "Repo A",
              backend: "codex" as const,
              executionMode: "default" as const,
              workMode: "local" as const,
              prompt: "keep me",
              createdAt: 1,
              updatedAt: 1,
            },
          },
          {
            key: "directory:/repo-b",
            kind: "directory" as const,
            label: "Repo B",
            threadKeys: [],
            needsAttentionCount: 0,
            launchpad: {
              directoryKey: "directory:/repo-b",
              directoryKind: "directory" as const,
              directoryLabel: "Repo B",
              backend: "acp:kimi" as const,
              executionMode: "default" as const,
              workMode: "local" as const,
              prompt: "leave me alone",
              createdAt: 1,
              updatedAt: 1,
            },
          },
        ],
        launchpadDefaults: {
          backend: "codex" as const,
          executionMode: "default" as const,
          workMode: "local" as const,
        },
        threads: [
          {
            id: "codex-1",
            title: "Codex one",
            createdAt: 1,
            updatedAt: 1,
            linkedDirectories: [],
            source: "codex" as const,
            model: "gpt-5.5",
            fastMode: true,
            inbox: { inInbox: true },
          },
          {
            id: "codex-2",
            title: "Codex two",
            createdAt: 1,
            updatedAt: 1,
            linkedDirectories: [],
            source: "codex" as const,
            model: "gpt-5.6-terra",
            fastMode: true,
            inbox: { inInbox: true },
          },
          {
            id: "codex-3",
            title: "Codex three",
            createdAt: 1,
            updatedAt: 1,
            linkedDirectories: [],
            source: "codex" as const,
            model: "gpt-5.6-sol",
            fastMode: false,
            inbox: { inInbox: true },
          },
          {
            id: "kimi-1",
            title: "Kimi",
            createdAt: 1,
            updatedAt: 1,
            linkedDirectories: [],
            source: "acp:kimi" as const,
            inbox: { inInbox: true },
          },
        ],
      })),
      turnOffCodexFastEverywhere,
      updateDirectoryLaunchpad,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    const { rerender } = render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="models"
        settings={settings}
      />,
    );

    const reasoning = await screen.findByLabelText("Codex default reasoning");
    fireEvent.change(reasoning, { target: { value: "xhigh" } });
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          providerDefaults: {
            codex: {
              model: "gpt-5.6-sol",
              reasoningEffortsByModel: {
                "gpt-5.6-sol": "xhigh",
              },
            },
          },
        },
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Apply to launchpads" }));
    const launchpadConfirmation =
      await screen.findByText("Apply to 1 launchpad?");
    expect(launchpadConfirmation.closest(".settings-field")).toHaveTextContent(
      "Codex",
    );
    expect(
      screen.queryByRole("button", { name: "Apply to launchpads" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(updateDirectoryLaunchpad).toHaveBeenCalledTimes(1);
    });
    expect(updateDirectoryLaunchpad).toHaveBeenCalledWith({
      directoryKey: "directory:/repo-a",
      patch: {
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
      },
      stickySettingsChanged: true,
    });
    expect(
      screen.getByText(
        "Updated 1 Codex launchpad. Existing threads were not changed.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Codex default model" }),
    ).toHaveClass("settings-select--chip");
    expect(
      screen.getByRole("combobox", { name: "Codex default reasoning" }),
    ).toHaveClass("settings-select--chip");

    fireEvent.click(
      screen.getByRole("button", { name: "Schedule existing threads…" }),
    );
    const migrationDialog = await screen.findByRole("dialog", {
      name: "Choose Codex threads to update",
    });
    expect(
      within(migrationDialog).getByText("2 selected of 3 threads"),
    ).toBeInTheDocument();
    const terraGroup = within(migrationDialog).getByRole("option", {
      name: /GPT-5.6-Terra.*1 thread/,
    });
    const oldModelGroup = within(migrationDialog).getByRole("option", {
      name: /GPT-5.5.*1 thread/,
    });
    const destinationGroup = within(migrationDialog).getByRole("option", {
      name: /GPT-5.6-Sol.*destination model.*1 thread/,
    });
    expect(terraGroup).toHaveAttribute("aria-selected", "true");
    expect(destinationGroup).toHaveAttribute("aria-selected", "false");
    fireEvent.click(
      within(migrationDialog).getByRole("button", { name: "Clear" }),
    );
    expect(
      within(migrationDialog).getByText("0 selected of 3 threads"),
    ).toBeInTheDocument();
    fireEvent.click(oldModelGroup);
    fireEvent.click(destinationGroup, { shiftKey: true });
    expect(
      within(migrationDialog).getByText("2 selected of 3 threads"),
    ).toBeInTheDocument();
    fireEvent.click(
      within(migrationDialog).getByRole("button", { name: "Clear" }),
    );
    fireEvent.click(oldModelGroup);
    expect(
      within(migrationDialog).getByText("1 selected of 3 threads"),
    ).toBeInTheDocument();
    expect(terraGroup).toHaveAttribute("aria-selected", "false");
    expect(oldModelGroup).toHaveAttribute("aria-selected", "true");
    fireEvent.click(
      within(migrationDialog).getByRole("button", {
        name: "Schedule 1 thread",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          providerThreadMigrations: {
            codex: {
              revision: expect.any(String),
              model: "gpt-5.6-sol",
              reasoningEffort: "high",
              sourceModels: ["gpt-5.5"],
              createdAt: expect.any(Number),
            },
          },
        },
      });
    });
    expect(
      within(migrationDialog).getByText(/This exact migration is already scheduled/),
    ).toHaveTextContent(
      "1 thread is still pending; 0 already acknowledged this revision.",
    );
    expect(
      within(migrationDialog).getByRole("button", {
        name: "Done",
      }),
    ).toBeEnabled();
    expect(
      within(migrationDialog).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(migrationDialog).getByRole("button", { name: "Done" }),
    );
    expect(migrationDialog).not.toBeInTheDocument();

    snapshot.models.providerThreadMigrations = {
      codex: {
        revision: "saved-migration",
        model: "gpt-5.6-sol",
        reasoningEffort: "high",
        sourceModels: ["gpt-5.5"],
        createdAt: Date.now(),
      },
    };
    rerender(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="models"
        settings={settings}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Schedule existing threads…" }),
    );
    const scheduledDialog = await screen.findByRole("dialog", {
      name: "Choose Codex threads to update",
    });
    expect(
      within(scheduledDialog).getByText(/This exact migration is already scheduled/),
    ).toHaveTextContent(
      "1 thread is still pending; 0 already acknowledged this revision.",
    );
    expect(
      within(scheduledDialog).getByRole("button", {
        name: "Done",
      }),
    ).toBeEnabled();
    expect(
      within(scheduledDialog).queryByRole("button", { name: "Cancel" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(scheduledDialog).getByRole("button", { name: "Done" }),
    );
    expect(scheduledDialog).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn Fast off everywhere" }),
    );
    const fastConfirmation =
      await screen.findByText("Turn Fast off everywhere?");
    expect(fastConfirmation.closest(".settings-field")).toHaveTextContent(
      "Codex",
    );
    expect(fastConfirmation.closest(".settings-field")).toHaveTextContent(
      "Fast mode",
    );
    expect(
      screen.queryByRole("button", { name: "Turn Fast off everywhere" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn Fast off" }));
    await waitFor(() => {
      expect(turnOffCodexFastEverywhere).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.getByText(
        "Fast is off for 2 Codex threads and 1 saved launchpad. Future Codex launchpads will also start non-Fast.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("switch", { name: "Allow Codex Fast mode" }),
    );
    expect(
      await screen.findByText("Prohibit Fast for this profile?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Turn Fast off" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        models: {
          codex: {
            allowFast: false,
          },
        },
      });
    });
    expect(turnOffCodexFastEverywhere).toHaveBeenCalledTimes(2);
  });

  it("can restart login for an existing Codex auth profile", async () => {
    const snapshot = createSnapshot();
    snapshot.models.codex.profiles.profiles[1]!.hasAuthFile = false;
    const settings = createSettingsState(snapshot);
    const startCodexAuthProfileLogin = vi.fn(async () => ({
      profile: "work",
      codexHome: "/home/example/.codex/profiles/work",
      started: true,
      loginUrl: "https://auth.openai.com/oauth/authorize?client_id=codex",
    }));
    const checkCodexAuthProfileStatus = vi.fn(async () => ({
      profile: "work",
      codexHome: "/home/example/.codex/profiles/work",
      authenticated: true,
      status: "authenticated" as const,
      detail: "Logged in",
    }));
    let focusCallback: (() => void) | undefined;
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const desktopApi = {
      startCodexAuthProfileLogin,
      checkCodexAuthProfileStatus,
      onWindowFocus: vi.fn((callback: () => void) => {
        focusCallback = callback;
        return () => {
          focusCallback = undefined;
        };
      }),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="models"
        initialSubsection="codex"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Log in to Codex profile",
    });
    await waitFor(() => {
      expect(startCodexAuthProfileLogin).toHaveBeenCalledWith({
        profile: "work",
      });
    });
    expect(dialog).toHaveTextContent("work");
    expect(dialog).not.toHaveTextContent("https://auth.openai.com");

    fireEvent.click(
      within(dialog).getByRole("button", {
        name: "open the login link again",
      }),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://auth.openai.com/oauth/authorize?client_id=codex",
      "_blank",
      "noopener,noreferrer",
    );

    await act(async () => {
      focusCallback?.();
    });
    await waitFor(() => {
      expect(checkCodexAuthProfileStatus).toHaveBeenCalledWith({
        profile: "work",
      });
    });
    await waitFor(() => {
      expect(dialog).toHaveTextContent("work is logged in.");
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => {
      expect(settings.refresh).toHaveBeenCalled();
    });
  });

  it("shows authenticated when Codex login exits after auth already exists", async () => {
    const snapshot = createSnapshot();
    snapshot.models.codex.profiles.profiles[1]!.hasAuthFile = false;
    const settings = createSettingsState(snapshot);
    const startCodexAuthProfileLogin = vi.fn(async () => ({
      profile: "work",
      codexHome: "/home/example/.codex/profiles/work",
      started: false,
      authenticated: true,
    }));
    const desktopApi = {
      startCodexAuthProfileLogin,
      checkCodexAuthProfileStatus: vi.fn(),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="models"
        initialSubsection="codex"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Login" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Log in to Codex profile",
    });
    await waitFor(() => {
      expect(dialog).toHaveTextContent("work is logged in.");
    });
    expect(dialog).not.toHaveTextContent("Codex login exited before emitting a login link");
  });

  it("lets an available Token Miser experiment default threads on or off", async () => {
    const snapshot = createSnapshot();
    snapshot.experimental.tokenMiserEnabled = { value: true, source: "config" };
    snapshot.experimental.tokenMiserDefaultEnabled = {
      value: false,
      source: "config",
    };
    snapshot.runtime.tokenMiser = {
      activation: { observedAt: 1_800_000_000_000, state: "active" },
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Opt-in")).toBeInTheDocument();
    const defaultSwitch = screen.getByRole("switch", {
      name: "Enable on threads by default — Token Miser",
    });
    expect(defaultSwitch).toHaveAttribute("aria-checked", "false");
    expect(defaultSwitch).not.toBeDisabled();
    fireEvent.click(defaultSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { tokenMiserDefaultEnabled: true },
      });
    });
  });

  it("shows when the managed Codex switch is waiting for idle", async () => {
    const snapshot = createSnapshot();
    snapshot.experimental.tokenMiserEnabled = { value: true, source: "config" };
    snapshot.runtime.tokenMiser = {
      activation: { observedAt: 1_800_000_000_000, state: "active" },
      managedCodex: {
        state: "pending-switch",
        version: "0.201.0-pwragent.1",
      },
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Waiting for idle")).toBeInTheDocument();
    expect(screen.queryByText("Default on")).not.toBeInTheDocument();
  });

  it("keeps stale activation failures hidden while a managed switch is pending", async () => {
    const snapshot = createSnapshot();
    snapshot.experimental.tokenMiserEnabled = { value: true, source: "config" };
    snapshot.runtime.tokenMiser = {
      activation: {
        observedAt: 1_800_000_000_000,
        reason: "The previous Codex runtime lacked native activation.",
        state: "unavailable",
      },
      managedCodex: {
        state: "pending-switch",
        version: "0.201.0-pwragent.1",
      },
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    };

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Waiting for idle")).toBeInTheDocument();
    expect(screen.queryByText("Codex could not load the gate")).not.toBeInTheDocument();
  });

  it("shows Token Miser as installing while one-click enablement is running", async () => {
    const snapshot = createSnapshot();
    let finishWrite: (() => void) | undefined;
    const settings = createSettingsState(snapshot);
    settings.writeConfig = vi.fn(() => new Promise<boolean>((resolve) => {
      finishWrite = () => resolve(true);
    }));

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const availabilitySwitch = screen.getByRole("switch", {
      name: "Make Token Miser available",
    });
    fireEvent.click(availabilitySwitch);

    expect(screen.getByText("Installing")).toBeInTheDocument();
    expect(availabilitySwitch).toHaveAttribute("aria-checked", "true");
    expect(availabilitySwitch).toBeDisabled();
    finishWrite?.();
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { tokenMiserEnabled: true },
      });
    });
  });

  // Token Miser fails open, so an inert gate is invisible: turns keep running
  // and nothing is gated. Settings has to state the contradiction outright.
  it("warns when Token Miser is enabled but Codex never loaded the gate", async () => {
    const snapshot = createSnapshot();
    snapshot.experimental.tokenMiserEnabled = { value: true, source: "config" };
    snapshot.runtime.tokenMiser = {
      activation: {
        observedAt: 1_800_000_000_000,
        reason: "marketplace 'pwragent-local' is already added from a different source",
        state: "unavailable",
      },
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Codex could not load the gate")).toBeInTheDocument();
    expect(screen.getByText("Enabled, not running")).toBeInTheDocument();
    expect(
      screen.getByText(/already added from a different source/),
    ).toBeInTheDocument();
  });

  it("leaves the Token Miser section unflagged when the gate loaded", async () => {
    const snapshot = createSnapshot();
    snapshot.experimental.tokenMiserEnabled = { value: true, source: "config" };
    snapshot.runtime.tokenMiser = {
      activation: { observedAt: 1_800_000_000_000, state: "active" },
      interceptionCount: 0,
      originalCharacters: 0,
      baselineParentTokens: 0,
      replacementTokens: 0,
      retrievedTokens: 0,
      estimatedParentTokensSaved: 0,
    };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        desktopApi={{} as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"]}
        initialSection="experimental"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText("Codex could not load the gate")).not.toBeInTheDocument();
  });

  it("shows resolved gh discovery details and saves an alternate candidate", async () => {
    const snapshot = createSnapshot();
    snapshot.applications.gh = {
      path: { value: "", source: "default" },
      discovery: {
        selectedCommand: "/opt/homebrew/bin/gh",
        selectedSource: "homebrew",
        candidates: [
          {
            command: "/opt/homebrew/bin/gh",
            executable: true,
            selected: true,
            source: "homebrew",
            version: "2.88.1",
          },
          {
            command: "/usr/local/bin/gh",
            executable: true,
            selected: false,
            source: "homebrew",
            version: "2.80.0",
          },
        ],
      },
    };
    const settings = createSettingsState(snapshot);
    const getGhStatus = vi.fn(async () => ({
      installed: true,
      command: "/opt/homebrew/bin/gh",
      version: "2.88.1",
      loggedIn: true,
      account: "fixtureuser",
      scopes: ["repo"],
      hasRepoScope: true,
      discovery: snapshot.applications.gh.discovery,
    }));

    render(
      <SettingsScreen
        desktopApi={{ getGhStatus }}
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const ghPanel = screen.getByRole("heading", { name: "GitHub CLI (gh)" })
      .closest("section")!;
    expect(await within(ghPanel).findByText("Path:")).toBeInTheDocument();
    expect(within(ghPanel).getAllByText("/opt/homebrew/bin/gh").length).toBeGreaterThanOrEqual(1);
    expect(within(ghPanel).getAllByText("2.88.1").length).toBeGreaterThanOrEqual(1);
    expect(within(ghPanel).getByText("Signed in as")).toBeInTheDocument();

    fireEvent.click(
      within(ghPanel).getByRole("button", {
        name: "Use Homebrew gh at /usr/local/bin/gh",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        applications: {
          gh: {
            path: "/usr/local/bin/gh",
          },
        },
      });
    });
    expect(getGhStatus).toHaveBeenCalledWith({ recheck: true });
  });

  it("lists a pinned Codex whose version probe failed, and the one in use", async () => {
    // Upstream's most common rejection is executable:true with the reason in
    // versionFailureReason and no failureReason. Keying the list on
    // failureReason hid exactly that row from the operator who pinned it,
    // and a validated config row had no "Using" entry at all.
    const snapshot = createSnapshot();
    snapshot.models.codex.discovery = {
      selectedCommand: "C:\\nvm4w\\nodejs\\codex.cmd",
      selectedSource: "config",
      candidates: [
        {
          command: "C:\\nvm4w\\nodejs\\codex.cmd",
          executable: true,
          selected: true,
          source: "config",
          version: "0.146.0",
        },
        {
          command: "C:\\pinned\\codex.cmd",
          executable: true,
          selected: false,
          source: "env",
          versionFailureReason: "version_not_reported",
        },
      ],
    };

    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    const rows = Array.from(
      document.querySelectorAll(".settings-pathrow"),
    ).map((row) => row.textContent ?? "");
    expect(rows.some((row) => row.includes("C:\\pinned\\codex.cmd"))).toBe(true);
    expect(rows.some((row) => row.includes("C:\\nvm4w\\nodejs\\codex.cmd"))).toBe(
      true,
    );
  });

  it("shows the installed version on a Codex rejected as too old", async () => {
    // Upstream builds a codex_too_old candidate as executable:false WITH a
    // version — the rejection is derived from parsing one. Gating the version
    // chip on usability therefore hid the number on every platform, and
    // commandDiscoveryFailureDetail returns undefined for a classified reason
    // so the detail line could not recover it either.
    const snapshot = createSnapshot();
    snapshot.models.codex.discovery = {
      selectedCommand: "",
      selectedSource: "path",
      candidates: [
        {
          command: "/usr/local/bin/codex",
          executable: false,
          failureReason: "codex_too_old",
          selected: false,
          source: "path",
          version: "0.100.0",
        },
      ],
    };

    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    const chips = Array.from(
      document.querySelectorAll(".settings-pathrow__chip"),
    ).map((chip) => chip.textContent ?? "");
    expect(chips).toContain("0.100.0");
    expect(chips).toContain("Codex too old");

    // Still unusable: no Use button on a rejected candidate.
    const row = Array.from(document.querySelectorAll(".settings-pathrow")).find(
      (candidate) => candidate.textContent?.includes("/usr/local/bin/codex"),
    )!;
    expect(within(row as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("keeps a raw Codex spawn error out of the status chips", async () => {
    // Regression: a failed Windows probe returns a whole command line as its
    // reason. The row used to render it as BOTH the version chip and the
    // status chip; chips are `flex: 0 0 auto`, so the path beside them
    // collapsed to "C:" and the row overflowed.
    const rawFailure =
      "Command failed: C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0"
      + "\\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy"
      + " Bypass -File C:\\nvm4w\\nodejs\\codex.ps1 --version";
    const snapshot = createSnapshot();
    snapshot.models.codex.discovery = {
      selectedCommand: "C:\\nvm4w\\nodejs\\codex.cmd",
      selectedSource: "path",
      candidates: [
        {
          command: "C:\\nvm4w\\nodejs\\codex.cmd",
          executable: true,
          selected: true,
          source: "path",
          version: "0.146.0",
        },
        {
          command: "C:\\nvm4w\\nodejs\\codex.ps1",
          executable: false,
          selected: false,
          source: "path",
          failureReason: rawFailure,
        },
        {
          command:
            "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.810.7004.0_x64"
            + "\\app\\resources\\codex.exe",
          executable: false,
          selected: false,
          source: "application",
          failureReason: "spawn EPERM",
        },
      ],
    };

    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    const chips = Array.from(
      document.querySelectorAll(".settings-pathrow__chip"),
    ).map((chip) => chip.textContent ?? "");
    expect(chips).toContain("Launch failed");
    expect(chips).toContain("Blocked");
    expect(chips.some((chip) => chip.includes("powershell.exe"))).toBe(false);
    // "spawn EPERM" previously rendered twice on the same row.
    expect(chips.filter((chip) => chip === "Blocked")).toHaveLength(1);

    // The full reason stays reachable on the row's mono detail line.
    expect(screen.getByText(rawFailure)).toBeInTheDocument();

    // An unusable candidate must not offer to become the selection.
    const rows = Array.from(document.querySelectorAll(".settings-pathrow"));
    const failingRow = rows.find((row) =>
      row.textContent?.includes("codex.ps1"),
    )!;
    expect(within(failingRow as HTMLElement).queryByRole("button")).toBeNull();
  });

  it("shows Git discovery and Xcode license remediation", async () => {
    const snapshot = createSnapshot();
    snapshot.applications.git = {
      path: { value: "", source: "default" },
      discovery: {
        selectedCommand: "/opt/homebrew/bin/git",
        selectedSource: "homebrew",
        candidates: [
          {
            command: "/opt/homebrew/bin/git",
            executable: true,
            selected: true,
            source: "homebrew",
            version: "2.39.1",
          },
          {
            command: "/usr/bin/git",
            executable: false,
            selected: false,
            source: "xcode",
            failureReason:
              "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'",
          },
          {
            command: "/usr/local/bin/git",
            executable: false,
            selected: false,
            source: "homebrew",
            failureReason: "not_found",
          },
        ],
      },
    };
    const settings = createSettingsState(snapshot);
    const copyTextMock = vi.fn(async () => undefined);

    render(
      <SettingsScreen
        desktopApi={{ copyText: copyTextMock }}
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const gitPanel = screen.getByRole("heading", { name: "Git" }).closest("section")!;
    expect(within(gitPanel).getAllByText("/opt/homebrew/bin/git").length).toBeGreaterThanOrEqual(1);
    expect(within(gitPanel).getByText(/Apple's Git at/)).toBeInTheDocument();
    expect(within(gitPanel).queryByText("/usr/local/bin/git")).not.toBeInTheDocument();
    expect(
      within(gitPanel).getByText("sudo xcodebuild -license"),
    ).toBeInTheDocument();

    fireEvent.click(within(gitPanel).getByRole("button", { name: "Copy command" }));
    await waitFor(() => {
      expect(copyTextMock).toHaveBeenCalledWith("sudo xcodebuild -license");
    });
  });

  it("selects a git candidate and shows what signed each one", async () => {
    const snapshot = createSnapshot();
    snapshot.applications.git = {
      path: { value: "", source: "default" },
      discovery: {
        selectedCommand: "/opt/homebrew/bin/git",
        selectedSource: "homebrew",
        candidates: [
          {
            command: "/opt/homebrew/bin/git",
            executable: true,
            selected: true,
            source: "homebrew",
            version: "2.54.0",
          },
          {
            command: "/usr/bin/git",
            executable: true,
            selected: false,
            source: "xcode",
            version: "2.50.1",
          },
        ],
      },
    };
    const settings = createSettingsState(snapshot);
    const inspectCodeSignatures = vi.fn(async () => ({
      signatures: [
        { path: "/opt/homebrew/bin/git", trust: "adhoc" as const },
        {
          path: "/usr/bin/git",
          trust: "platform" as const,
          signer: "macOS Software Signing",
        },
      ],
    }));
    const refreshGitDiscovery = vi.fn(async () => ({ snapshot }));

    render(
      <SettingsScreen
        desktopApi={{ inspectCodeSignatures, refreshGitDiscovery }}
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const gitPanel = screen
      .getByRole("heading", { name: "Git" })
      .closest("section")!;

    // The provenance is the title, because every row here is `git` and the
    // choice being made is Homebrew's or Apple's.
    expect(within(gitPanel).getByText("Homebrew")).toBeInTheDocument();
    expect(within(gitPanel).getByText("Apple")).toBeInTheDocument();
    expect(within(gitPanel).getByText("2.50.1")).toBeInTheDocument();

    // Signatures arrive after the rows paint.
    expect(await within(gitPanel).findByText("Ad-hoc")).toBeInTheDocument();
    expect(within(gitPanel).getByText("System")).toBeInTheDocument();

    // The whole row is the control: before this, git rows had no action at
    // all and clicking one did nothing.
    fireEvent.click(
      within(gitPanel).getByRole("button", {
        name: "Use Apple git at /usr/bin/git",
      }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        applications: {
          git: {
            path: "/usr/bin/git",
          },
        },
      });
    });
    // Selecting has to re-probe: a plain projection re-read would serve the
    // memoized startup snapshot back and the pane would look unchanged.
    expect(refreshGitDiscovery).toHaveBeenCalled();
  });

  it("does not offer a git selection while PWRAGENT_GIT_PATH is set", () => {
    const snapshot = createSnapshot();
    snapshot.applications.git = {
      path: { value: "/opt/env/git", source: "env" },
      discovery: {
        selectedCommand: "/opt/env/git",
        selectedSource: "env",
        candidates: [
          {
            command: "/opt/env/git",
            executable: true,
            selected: true,
            source: "env",
            version: "2.54.0",
          },
          {
            command: "/usr/bin/git",
            executable: true,
            selected: false,
            source: "xcode",
            version: "2.50.1",
          },
        ],
      },
    };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const gitPanel = screen
      .getByRole("heading", { name: "Git" })
      .closest("section")!;
    expect(
      within(gitPanel).getByRole("button", {
        name: "Use Apple git at /usr/bin/git",
      }),
    ).toBeDisabled();
    expect(within(gitPanel).getByText(/PWRAGENT_GIT_PATH is set/)).toBeInTheDocument();
  });

  it("renders the Mattermost section and saves edits via writeConfig", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Mattermost settings" }),
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Mattermost" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Server URL")).toBeInTheDocument();
    expect(screen.getAllByText("Callback Base URL").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Register slash commands").length).toBeGreaterThan(0);
    // The slash command prefix field should be disabled while
    // registerSlashCommands is off.
    const prefixInput = screen.getAllByLabelText("Slash command prefix")[0]!;
    expect(prefixInput).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://chat.example.com" },
    });
    fireEvent.blur(screen.getByLabelText("Server URL"));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          mattermost: {
            serverUrl: "https://chat.example.com",
          },
        },
      });
    });

    fireEvent.click(
      screen.getAllByRole("switch", { name: "Register slash commands" })[0]!,
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          mattermost: {
            registerSlashCommands: true,
          },
        },
      });
    });
  });

  it("shows direct default Agents on approved messaging surfaces", async () => {
    const baseSnapshot = createSnapshot();
    const routes: ListMessagingRoutesResponse = {
      eligibleAgents: [
        {
          backend: "codex",
          threadId: "agent-1",
          label: "Jeeves",
          backendLabel: "OpenAI",
          backendAvailable: true,
          available: true,
        },
      ],
      defaultAgents: [
        {
          assignmentId: "assignment-1",
          scope: {
            kind: "parent",
            platform: "telegram",
            conversationId: "-100123",
          },
          target: {
            backend: "codex",
            threadId: "agent-1",
            label: "Jeeves",
            backendLabel: "OpenAI",
            backendAvailable: true,
            available: true,
          },
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      bindings: [],
      observedSurfaces: [],
    };
    const snapshot = createSnapshot({
      messaging: {
        ...baseSnapshot.messaging,
        telegram: {
          ...baseSnapshot.messaging.telegram,
          authorizedUserIds: {
            value: [{ id: "12345", displayName: "Harold" }],
            source: "config",
          },
          authorizedSupergroups: {
            value: [{ id: "-100123", displayName: "PwrAgent Dev" }],
            source: "config",
          },
        },
      },
    });

    render(
      <SettingsScreen
        desktopApi={{
          listMessagingRoutes: vi.fn(async () => routes),
          onMessagingBindingsChanged: () => () => undefined,
        }}
        initialSection="messaging"
        initialSubsection="telegram"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("Topic default Agent")).toBeInTheDocument();
    // Routes (with their own default-agent list) live on the messaging
    // hub now, so the focused Telegram screen shows one "Jeeves": the
    // approved surface's picker.
    expect(screen.getAllByText("Jeeves")).toHaveLength(1);
    expect(
      screen.getAllByText("OpenAI").every(
        (element) => element.classList.contains("chip--backend"),
      ),
    ).toBe(true);
    expect(
      screen.getByRole("button", {
        name: "Change default Agent for PwrAgent Dev",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Direct message default Agent"))
      .not.toBeInTheDocument();
  });

  it("validates messaging authorized IDs inline and refuses invalid saves", async () => {
    const settings = createSettingsState();
    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/Authorization defaults closed/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Telegram settings" }),
    );
    expect(screen.getByText(/Rejected Telegram DMs show the peer ID/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    const telegramUserIds = screen.getByLabelText("Authorized User IDs ID 1");
    fireEvent.change(telegramUserIds, { target: { value: "@fixtureuser" } });
    fireEvent.blur(telegramUserIds);

    expect(
      await screen.findByText(/That looks like a Telegram username/),
    ).toBeInTheDocument();
    expect(telegramUserIds).toHaveAttribute("aria-invalid", "true");
    expect(settings.writeConfig).not.toHaveBeenCalledWith({
      messaging: {
        telegram: {
          authorizedUserIds: [{ id: "@fixtureuser", displayName: "" }],
        },
      },
    });

    fireEvent.change(telegramUserIds, { target: { value: "8460800771" } });
    fireEvent.change(
      screen.getByLabelText("Authorized User IDs display name 1"),
      { target: { value: "Harold (@fixtureuser)" } },
    );
    fireEvent.blur(telegramUserIds);

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [
              { id: "8460800771", displayName: "Harold (@fixtureuser)" },
            ],
          },
        },
      });
    });
  });

  it("labels LINE webhook settings as public URL and local listener", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        initialSection="messaging"
        initialSubsection="line"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Webhook URL")).toHaveAttribute(
      "placeholder",
      "https://line-webhook.example.com/",
    );
    expect(screen.getByPlaceholderText("http://127.0.0.1:47822")).toHaveAccessibleName(
      "Local Webhook Listener",
    );
    expect(screen.getByPlaceholderText("http://127.0.0.1:47822")).toHaveAttribute(
      "placeholder",
      "http://127.0.0.1:47822",
    );
    expect(screen.getByText(/forwards LINE webhooks/)).toBeInTheDocument();
    expect(screen.queryByText("https://line-callback.example.com/")).not.toBeInTheDocument();
  });

  it("treats Feishu tenant and webhook URLs as optional overrides", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        initialSection="messaging"
        initialSubsection="feishu"
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText(/Required before going online/)).toHaveLength(2);
    expect(screen.getByText(/go online in Lark Developer/)).toBeInTheDocument();
    expect(screen.getByText(/Feishu is China only/)).toBeInTheDocument();
    expect(screen.getByLabelText("Tenant URL")).toHaveValue("");
    expect(screen.getByText(/Leave blank to use/)).toBeInTheDocument();
    // Events mode hides the Feishu local webhook listener (LINE's
    // listener now lives on LINE's own screen).
    expect(
      screen.queryByLabelText("Local Webhook Listener"),
    ).not.toBeInTheDocument();
  });

  it("shows the Feishu local webhook listener only for webhook mode", () => {
    const snapshot = createSnapshot();
    snapshot.messaging.feishu.inboundMode = { value: "webhook", source: "config" };

    render(
      <SettingsScreen
        settings={createSettingsState(snapshot)}
        initialSection="messaging"
        initialSubsection="feishu"
        onClose={() => undefined}
      />,
    );

    const feishuLocalWebhook = screen.getByLabelText("Local Webhook Listener");
    expect(feishuLocalWebhook).toHaveValue("");
    expect(screen.getByText(/Default:/)).toHaveTextContent("http://127.0.0.1:47823");
    expect(screen.getByText(/Only used when Webhook is selected/)).toBeInTheDocument();
  });

  it("looks up blank messaging display names from the settings screen", async () => {
    const settings = createSettingsState();
    const resolveMessagingContact = vi.fn(async () => ({
      status: "ok" as const,
      id: "8460800771",
      displayName: "Harold (@fixtureuser)",
      handle: "@fixtureuser",
    }));
    const desktopApi = {
      resolveMessagingContact,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    const telegramUserIds = screen.getByLabelText("Authorized User IDs ID 1");
    fireEvent.change(telegramUserIds, { target: { value: "8460800771" } });
    fireEvent.blur(telegramUserIds);

    await waitFor(() => {
      expect(resolveMessagingContact).toHaveBeenCalledWith({
        platform: "telegram",
        kind: "user",
        id: "8460800771",
      });
    });
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [
              { id: "8460800771", displayName: "Harold (@fixtureuser)" },
            ],
          },
        },
      });
    });
    expect(
      screen.getByLabelText("Authorized User IDs display name 1"),
    ).toHaveValue("Harold (@fixtureuser)");
  });

  it("copies generated pairing messages through the clipboard fallback", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          enabled: { value: true, source: "config" as const },
        },
      },
    });
    const pairingMessage = "pair 123456789ABCDEFGHJKLMNPQRSTUVWXY";
    const bridgeCopy = vi.fn(async () => {
      throw new Error("bridge clipboard unavailable");
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    });
    const desktopApi = {
      copyText: bridgeCopy,
      generateMessagingPairingToken: vi.fn(async () => ({
        entry: {
          id: "pairing-1",
          platform: "telegram" as const,
          instanceId: "default",
          scope: "user_dm" as const,
          status: "pending" as const,
          generatedAt: 1,
          expiresAt: 2,
        },
        expiresAt: 2,
        message: pairingMessage,
        token: "123456789ABCDEFGHJKLMNPQRSTUVWXY",
      })),
      listMessagingPairingRequests: vi.fn(async () => ({ entries: [] })),
      onMessagingPairingChanged: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Generate" })[0]!);
    expect(await screen.findByText(pairingMessage)).toBeInTheDocument();

    // Generating auto-copies the code (bridge fails, browser clipboard wins)
    // and the button flips to "Copied".
    await waitFor(() => {
      expect(bridgeCopy).toHaveBeenCalledWith(pairingMessage);
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(pairingMessage);
    });
    expect(
      await screen.findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
  });

  it("clears a generated pairing message after the token is observed", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          enabled: { value: true, source: "config" as const },
        },
      },
    });
    const pairingMessage = "pair 123456789ABCDEFGHJKLMNPQRSTUVWXY";
    const entry: MessagingPairingEntry = {
      id: "pairing-1",
      platform: "telegram",
      instanceId: "default",
      scope: "user_dm",
      status: "pending",
      generatedAt: 1,
      expiresAt: 2,
    };
    const pairingChangedCallbacks: Array<
      (event: { at: number; entry: MessagingPairingEntry }) => void
    > = [];
    const desktopApi = {
      generateMessagingPairingToken: vi.fn(async () => ({
        entry,
        expiresAt: 2,
        message: pairingMessage,
        token: "123456789ABCDEFGHJKLMNPQRSTUVWXY",
      })),
      listMessagingPairingRequests: vi.fn(async () => ({ entries: [] })),
      onMessagingPairingChanged: vi.fn((callback) => {
        pairingChangedCallbacks.push(callback);
        return () => undefined;
      }),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    const initialPairingChangedCallbacks = [...pairingChangedCallbacks];
    fireEvent.click(screen.getAllByRole("button", { name: "Generate" })[0]!);
    expect(await screen.findByText(pairingMessage)).toBeInTheDocument();
    expect(pairingChangedCallbacks).toHaveLength(initialPairingChangedCallbacks.length);

    act(() => {
      for (const callback of initialPairingChangedCallbacks) {
        callback({
          at: 3,
          entry: {
            ...entry,
            status: "observed",
            observedAt: 3,
            observedActor: { id: "8460800771", displayName: "Harold Hunt" },
            observedChat: { id: "8460800771", kind: "dm", title: "Harold Hunt" },
          },
        });
      }
    });

    // Bumped from the default 1000ms because CI runners under load take
    // ~1600ms+ for the pairingChanged → React state update → DOM removal
    // chain. Locally this completes in <100ms; the 5000ms ceiling
    // matches @testing-library's `waitForElementToBeRemoved` default,
    // but keeps `waitFor` so the assertion still succeeds when the
    // element is removed synchronously inside the act() above (which
    // `waitForElementToBeRemoved` would treat as an error).
    await waitFor(
      () => {
        expect(screen.queryByText(pairingMessage)).not.toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });

  it("refreshes authorized contacts after metadata-only pairing approval", async () => {
    const snapshot = createSnapshot();
    const initialSnapshot: DesktopSettingsSnapshot = {
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          enabled: { value: true, source: "config" },
          authorizedUserIds: {
            value: [{ id: "8460800771", displayName: "" }],
            source: "config" as const,
          },
        },
      },
    };
    const approvedSnapshot: DesktopSettingsSnapshot = {
      ...initialSnapshot,
      messaging: {
        ...initialSnapshot.messaging,
        telegram: {
          ...initialSnapshot.messaging.telegram,
          authorizedUserIds: {
            value: [{ id: "8460800771", displayName: "Harold Hunt" }],
            source: "config" as const,
          },
        },
      },
    };
    let approved = false;
    const observedEntry = {
      id: "pairing-1",
      platform: "telegram" as const,
      instanceId: "default",
      scope: "user_dm" as const,
      status: "observed" as const,
      generatedAt: 1,
      expiresAt: 2,
      observedAt: 1,
      observedActor: {
        id: "8460800771",
        displayName: "Harold Hunt",
        phoneNumber: "+15551234567",
        username: "fixtureuser",
      },
      observedChat: {
        id: "8460800771",
        kind: "dm" as const,
        title: "Harold Hunt",
      },
    };
    const refreshSpy = vi.fn();
    const approveMessagingPairing = vi.fn(async () => {
      approved = true;
      return {
        added: false,
        entry: {
          ...observedEntry,
          status: "consumed" as const,
        },
      };
    });
    const desktopApi = {
      approveMessagingPairing,
      listMessagingPairingRequests: vi.fn(async (request) => ({
        entries: !approved && request?.platform === "telegram" ? [observedEntry] : [],
      })),
      onMessagingPairingChanged: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    function Harness() {
      const [settingsSnapshot, setSettingsSnapshot] = useState(initialSnapshot);
      const settings = createSettingsState(settingsSnapshot);
      settings.refresh = vi.fn(async () => {
        refreshSpy();
        setSettingsSnapshot(approvedSnapshot);
      });
      return (
        <SettingsScreen
          desktopApi={desktopApi}
          settings={settings}
          initialSection="messaging"
          initialSubsection="telegram"
          onClose={() => undefined}
        />
      );
    }

    render(<Harness />);

    const request = await screen.findByText("Harold Hunt wants access");
    const requestCard = request.closest(".settings-pairing__request");
    expect(requestCard).not.toBeNull();
    expect(requestCard).toHaveTextContent("User ID 8460800771");
    expect(requestCard).toHaveTextContent("@fixtureuser");
    expect(requestCard).toHaveTextContent("Phone +15551234567");
    expect(requestCard).toHaveTextContent("DM peer ID 8460800771");

    fireEvent.click(within(requestCard as HTMLElement).getByRole("button", {
      name: "Approve",
    }));

    await waitFor(() => {
      expect(approveMessagingPairing).toHaveBeenCalledWith({ entryId: "pairing-1" });
    });
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(screen.getByDisplayValue("8460800771")).toBeInTheDocument();
    });
    expect(screen.getByDisplayValue("Harold Hunt")).toBeInTheDocument();
  });

  it("offers separate Slack pairing approvals for the observed user and channel", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        slack: {
          ...snapshot.messaging.slack,
          enabled: { value: true, source: "config" },
        },
      },
    });
    const observedEntry = {
      id: "pairing-slack-1",
      platform: "slack" as const,
      instanceId: "default",
      scope: "observed" as const,
      status: "observed" as const,
      generatedAt: 1,
      expiresAt: 2,
      observedAt: 1,
      observedActor: {
        id: "U012ABCDEF0",
        displayName: "Harold",
      },
      observedChat: {
        id: "C012ABCDEF0",
        kind: "channel" as const,
        title: "team-alerts",
        bucketId: "T025C2NKT",
      },
    };
    const approveMessagingPairing = vi.fn(async () => ({
      added: true,
      entry: {
        ...observedEntry,
        status: "consumed" as const,
      },
    }));
    const desktopApi = {
      approveMessagingPairing,
      listMessagingPairingRequests: vi.fn(async (request) => ({
        entries: request?.platform === "slack" ? [observedEntry] : [],
      })),
      onMessagingPairingChanged: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    const request = await screen.findByText("Harold sent a pairing request");
    const requestCard = request.closest(".settings-pairing__request");
    expect(requestCard).not.toBeNull();
    expect(requestCard).toHaveTextContent("User ID U012ABCDEF0");
    expect(requestCard).toHaveTextContent("Channel ID C012ABCDEF0");
    expect(requestCard).toHaveTextContent("team-alerts");

    fireEvent.click(within(requestCard as HTMLElement).getByRole("button", {
      name: "Approve channel",
    }));

    await waitFor(() => {
      expect(approveMessagingPairing).toHaveBeenCalledWith({
        entryId: "pairing-slack-1",
        target: "conversation",
        consume: false,
      });
    });

    fireEvent.click(within(requestCard as HTMLElement).getByRole("button", {
      name: "Approve user",
    }));

    await waitFor(() => {
      expect(approveMessagingPairing).toHaveBeenCalledWith({
        entryId: "pairing-slack-1",
        target: "actor",
        consume: false,
      });
    });

    // A workspace was observed, so a team approval is offered too.
    fireEvent.click(within(requestCard as HTMLElement).getByRole("button", {
      name: "Approve team",
    }));

    await waitFor(() => {
      expect(approveMessagingPairing).toHaveBeenCalledWith({
        entryId: "pairing-slack-1",
        target: "team",
        consume: false,
      });
    });
  });

  it("labels Telegram topic pairing request IDs distinctly", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          enabled: { value: true, source: "config" },
        },
      },
    });
    const observedEntry = {
      id: "pairing-topic-1",
      platform: "telegram" as const,
      instanceId: "default",
      scope: "bucket" as const,
      status: "observed" as const,
      generatedAt: 1,
      expiresAt: 2,
      observedAt: 1,
      observedActor: {
        id: "8460800771",
        displayName: "Harold Hunt",
      },
      observedChat: {
        id: "5642",
        kind: "topic" as const,
        title: "Release",
        parentId: "-1003841603622",
        parentTitle: "PwrDrvr",
        bucketId: "-1003841603622",
      },
    };
    const desktopApi = {
      listMessagingPairingRequests: vi.fn(async (request) => ({
        entries: request?.platform === "telegram" ? [observedEntry] : [],
      })),
      onMessagingPairingChanged: vi.fn(() => () => undefined),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    const request = await screen.findByText("Release wants group access");
    const requestCard = request.closest(".settings-pairing__request");
    expect(requestCard).not.toBeNull();
    expect(requestCard).toHaveTextContent("Topic ID 5642");
    expect(requestCard).toHaveTextContent("Supergroup ID -1003841603622");
    expect(requestCard).not.toHaveTextContent("Chat ID 5642");
    expect(requestCard).not.toHaveTextContent("Bucket ID -1003841603622");
  });

  it("looks up Slack authorized user display names", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        slack: {
          ...snapshot.messaging.slack,
          authorizedUserIds: {
            value: [{ id: "U079K80HTGS", displayName: "" }],
            source: "config",
          },
        },
      },
    });
    const resolveMessagingContact = vi.fn(async () => ({
      status: "ok" as const,
      id: "U079K80HTGS",
      displayName: "Harold Hunt",
      handle: "@hhunt",
    }));
    const desktopApi = {
      resolveMessagingContact,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    const warningPolicy = screen.getByRole("combobox", {
      name: "Authorized User IDs Full Access warning 1",
    });
    expect(warningPolicy.closest(".settings-authorized-list__policy")).toHaveTextContent(
      "Full Access warning",
    );
    expect(warningPolicy).toHaveAttribute(
      "title",
      "Controls whether this user sees the Full Access warning before escalation.",
    );
    expect(
      within(warningPolicy).getByRole("option", { name: "Warn, can dismiss" }),
    ).toBeInTheDocument();
    expect(
      within(warningPolicy).getByRole("option", { name: "Never warn" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Lookup Authorized User IDs row 1",
      }),
    );

    await waitFor(() => {
      expect(resolveMessagingContact).toHaveBeenCalledWith({
        platform: "slack",
        kind: "user",
        id: "U079K80HTGS",
      });
    });
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            authorizedUserIds: [{
              id: "U079K80HTGS",
              displayName: "Harold Hunt",
              username: "hhunt",
            }],
          },
        },
      });
    });
    const username = screen.getByLabelText("Authorized User IDs username 1");
    expect(username).toHaveValue("@hhunt");
    expect(username).toHaveAttribute("readonly");
  });

  it("clears and re-resolves a Slack username when its user ID changes", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        slack: {
          ...snapshot.messaging.slack,
          authorizedUserIds: {
            value: [{
              id: "U079K80HTGS",
              displayName: "Harold Hunt",
              username: "hhunt",
            }],
            source: "config",
          },
        },
      },
    });
    const resolveMessagingContact = vi.fn(async () => ({
      status: "ok" as const,
      id: "U012ABCDEF1",
      displayName: "New User",
      handle: "@newuser",
    }));
    const desktopApi = {
      resolveMessagingContact,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    const idInput = screen.getByLabelText("Authorized User IDs ID 1");
    const usernameInput = screen.getByLabelText("Authorized User IDs username 1");
    expect(usernameInput).toHaveValue("@hhunt");

    fireEvent.change(idInput, { target: { value: "U012ABCDEF1" } });
    expect(usernameInput).toHaveValue("");
    fireEvent.blur(idInput);

    await waitFor(() => {
      expect(resolveMessagingContact).toHaveBeenCalledWith({
        platform: "slack",
        kind: "user",
        id: "U012ABCDEF1",
      });
    });
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenLastCalledWith({
        messaging: {
          slack: {
            authorizedUserIds: [{
              id: "U012ABCDEF1",
              displayName: "New User",
              username: "newuser",
            }],
          },
        },
      });
    });
    expect(usernameInput).toHaveValue("@newuser");
  });

  it("places Slack channel pairing and defaults with channel authorization", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        slack: {
          ...snapshot.messaging.slack,
          enabled: { value: true, source: "config" },
        },
      },
    });

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    // The nav's Slack sub-item shares the name, so scope to the pane.
    const pane = screen.getByRole("region", {
      name: "Slack messaging settings",
    });
    const slackHeader = within(pane).getByRole("button", { name: "Slack" });
    if (slackHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(slackHeader);
    }
    const slackSection = slackHeader.closest("section");
    expect(slackSection).not.toBeNull();
    const slackControls = within(slackSection as HTMLElement);

    expect(
      slackControls.queryByRole("radio", { name: "User via channel" }),
    ).not.toBeInTheDocument();
    expect(
      slackControls.queryByRole("radio", { name: "Workspace" }),
    ).not.toBeInTheDocument();
    expect(
      slackControls.getByText(/approve the observed user or channel/i),
    ).toBeInTheDocument();
    expect(slackControls.getByText("Authorized Team IDs")).toBeInTheDocument();
    expect(slackControls.getByText("Team access default")).toBeInTheDocument();
    expect(slackControls.getByText("Channel access default")).toBeInTheDocument();
    expect(slackControls.getByText("Channel response default")).toBeInTheDocument();
    expect(slackControls.getByText("Authorized Channels")).toBeInTheDocument();
    expect(
      slackControls.getByText(
        /Require listed channels is the safest default/i,
      ),
    ).toBeInTheDocument();

    fireEvent.click(slackControls.getByRole("radio", { name: "Any channel" }));

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            channelAuthorizationMode: "allow_all",
          },
        },
      });
    });

    fireEvent.click(slackControls.getByRole("radio", { name: "Every message" }));

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            responseMode: "every_message",
          },
        },
      });
    });
  });

  it("allows replacing the Slack signing secret while Socket Mode is selected", async () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    const signingSecretInput = screen.getByLabelText("Signing Secret (Optional)");
    const signingSecretControls = signingSecretInput.closest(".settings-secret");
    expect(signingSecretInput).toBeEnabled();
    expect(signingSecretControls).not.toBeNull();

    fireEvent.change(signingSecretInput, {
      target: { value: "slack-signing-secret" },
    });
    fireEvent.click(
      within(signingSecretControls as HTMLElement).getByRole("button", {
        name: "Save",
      }),
    );

    await waitFor(() => {
      expect(settings.replaceSecret).toHaveBeenCalledWith(
        "slackSigningSecret",
        "slack-signing-secret",
      );
    });
  });

  it("does not offer the unimplemented Slack Events API inbound mode", () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("radio", { name: "Socket Mode" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Events API" })).not.toBeInTheDocument();
  });

  it("offers Connect Slack as the primary create-from-manifest path", async () => {
    const settings = createSettingsState();
    const openSlackCreateApp = vi.fn(async () => ({
      url: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
      oversized: false,
      manifestJson: "{}",
      opened: true,
    }));

    render(
      <SettingsScreen
        settings={settings}
        desktopApi={{ openSlackCreateApp }}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Create Slack app" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy manifest" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Open Slack Apps" })).toBeEnabled();
    expect(screen.getAllByText(/customer-owned Slack app/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Create Slack app" }));
    await waitFor(() => {
      expect(openSlackCreateApp).toHaveBeenCalledWith({ open: true });
    });
  });

  it("checks and requests the suggested Discord thread-reply permissions", async () => {
    const snapshot = createSnapshot();
    snapshot.messaging.discord.botToken = {
      configured: true,
      source: "keychain",
      writable: true,
    };
    snapshot.messaging.discord.authorizedGuilds.value = [
      { id: "1480556454498009353", displayName: "general" },
    ];
    const listDiscordThreadPermissionChannels = vi.fn(async () => ({
      channels: [
        {
          categoryName: "Chat",
          id: "1480556454498009352",
          kind: "text" as const,
          name: "general",
        },
      ],
      guildId: "1480556454498009353",
      guildName: "huntharo-claw",
      status: "ok" as const,
    }));
    const inspectDiscordThreadPermissions = vi.fn(async () => ({
      botId: "1480556454498009351",
      channelId: "1480556454498009352",
      checkedAt: 1,
      durationMs: 1,
      guildId: "1480556454498009353",
      permissions: [
        {
          granted: true,
          id: "create_public_threads" as const,
          label: "Create Public Threads",
        },
        {
          granted: false,
          id: "send_messages_in_threads" as const,
          label: "Send Messages in Threads",
        },
      ],
      status: "ok" as const,
    }));
    const openDiscordThreadPermissionRequest = vi.fn(async () => ({
      opened: true,
      url: "https://discord.com/oauth2/authorize",
    }));
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        settings={settings}
        desktopApi={{
          inspectDiscordThreadPermissions,
          listDiscordThreadPermissionChannels,
          openDiscordThreadPermissionRequest,
        }}
        initialSection="messaging"
        initialSubsection="discord"
        onClose={() => undefined}
      />,
    );

    const channelSelect = await screen.findByRole("combobox", {
      name: "Discord channel for permission check",
    });
    await waitFor(() => {
      expect(channelSelect).toHaveValue("1480556454498009352");
    });
    const serverSelect = screen.getByRole("combobox", {
      name: "Discord server for permission check",
    });
    expect(serverSelect).not.toHaveAccessibleName(/reply/i);
    expect(channelSelect).not.toHaveAccessibleName(/reply/i);
    expect(screen.getByRole("option", { name: "huntharo-claw" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Chat / #general" })).toBeInTheDocument();
    expect(listDiscordThreadPermissionChannels).toHaveBeenCalledWith({
      guildId: "1480556454498009353",
    });
    fireEvent.click(screen.getByRole("button", { name: "Check permissions" }));
    await waitFor(() => {
      expect(inspectDiscordThreadPermissions).toHaveBeenCalledWith({
        channelId: "1480556454498009352",
        guildId: "1480556454498009353",
      });
    });
    const permissionResult = screen.getByRole("alert", {
      name: "Discord permission check result",
    });
    expect(permissionResult).toHaveTextContent(
      "1 of 2 suggested permissions is missing.",
    );
    const permissionRows = within(permissionResult).getAllByRole("listitem");
    expect(permissionRows).toHaveLength(2);
    expect(permissionRows[0]).toHaveTextContent("Send Messages in ThreadsMissing");
    expect(permissionRows[1]).toHaveTextContent("Create Public ThreadsGranted");

    inspectDiscordThreadPermissions.mockResolvedValueOnce({
      botId: "1480556454498009351",
      channelId: "1480556454498009352",
      checkedAt: 2,
      durationMs: 1,
      guildId: "1480556454498009353",
      permissions: [
        {
          granted: true,
          id: "create_public_threads",
          label: "Create Public Threads",
        },
        {
          granted: true,
          id: "send_messages_in_threads",
          label: "Send Messages in Threads",
        },
      ],
      status: "ok",
    });
    fireEvent.click(screen.getByRole("button", { name: "Check permissions" }));
    expect(
      await screen.findByRole("status", { name: "Discord permission check result" }),
    ).toHaveTextContent("All 2 suggested permissions are granted.");

    fireEvent.click(
      screen.getByRole("button", { name: "Request suggested permissions" }),
    );
    await waitFor(() => {
      expect(openDiscordThreadPermissionRequest).toHaveBeenCalledWith({
        guildId: "1480556454498009353",
      });
    });
  });

  it("reconciles the Discord permission server after authorized guilds change", () => {
    const applicationId = "1480556454498009351";
    const firstGuildId = "1480556454498009353";
    const replacementGuildId = "1480556454498009354";
    const initialSnapshot = createSnapshot();
    initialSnapshot.messaging.discord.applicationId.value = applicationId;
    const openDiscordThreadPermissionRequest = vi.fn(async () => ({
      opened: true,
      url: "https://discord.com/oauth2/authorize",
    }));
    const view = render(
      <SettingsScreen
        settings={createSettingsState(initialSnapshot)}
        desktopApi={{ openDiscordThreadPermissionRequest }}
        initialSection="messaging"
        initialSubsection="discord"
        onClose={() => undefined}
      />,
    );

    expect(
      screen.getByRole("combobox", {
        name: "Discord server for permission check",
      }),
    ).toHaveValue("");

    const firstSnapshot = createSnapshot();
    firstSnapshot.messaging.discord.applicationId.value = applicationId;
    firstSnapshot.messaging.discord.authorizedGuilds.value = [
      { id: firstGuildId, displayName: "First guild" },
    ];
    view.rerender(
      <SettingsScreen
        settings={createSettingsState(firstSnapshot)}
        desktopApi={{ openDiscordThreadPermissionRequest }}
        initialSection="messaging"
        initialSubsection="discord"
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByRole("combobox", {
        name: "Discord server for permission check",
      }),
    ).toHaveValue(firstGuildId);

    const replacementSnapshot = createSnapshot();
    replacementSnapshot.messaging.discord.applicationId.value = applicationId;
    replacementSnapshot.messaging.discord.authorizedGuilds.value = [
      { id: replacementGuildId, displayName: "Replacement guild" },
    ];
    view.rerender(
      <SettingsScreen
        settings={createSettingsState(replacementSnapshot)}
        desktopApi={{ openDiscordThreadPermissionRequest }}
        initialSection="messaging"
        initialSubsection="discord"
        onClose={() => undefined}
      />,
    );
    expect(
      screen.getByRole("combobox", {
        name: "Discord server for permission check",
      }),
    ).toHaveValue(replacementGuildId);

    fireEvent.click(
      screen.getByRole("button", { name: "Request suggested permissions" }),
    );
    expect(openDiscordThreadPermissionRequest).toHaveBeenCalledWith({
      guildId: replacementGuildId,
    });
  });

  it("discards a Discord permission result after the channel selection changes", async () => {
    const firstChannelId = "1480556454498009352";
    const secondChannelId = "1480556454498009355";
    const guildId = "1480556454498009353";
    let resolveInspection!: (
      value: InspectDiscordThreadPermissionsResponse,
    ) => void;
    const inspectDiscordThreadPermissions = vi.fn(
      async (): Promise<InspectDiscordThreadPermissionsResponse> =>
        await new Promise<InspectDiscordThreadPermissionsResponse>((resolve) => {
          resolveInspection = resolve;
        }),
    );
    const listDiscordThreadPermissionChannels = vi.fn(async () => ({
      channels: [
        {
          id: firstChannelId,
          kind: "text" as const,
          name: "general",
        },
        {
          id: secondChannelId,
          kind: "text" as const,
          name: "coding",
        },
      ],
      guildId,
      guildName: "PwrAgent test guild",
      status: "ok" as const,
    }));
    const snapshot = createSnapshot();
    snapshot.messaging.discord.authorizedGuilds.value = [
      { id: guildId, displayName: "PwrAgent test guild" },
    ];
    render(
      <SettingsScreen
        settings={createSettingsState(snapshot)}
        desktopApi={{
          inspectDiscordThreadPermissions,
          listDiscordThreadPermissionChannels,
        }}
        initialSection="messaging"
        initialSubsection="discord"
        onClose={() => undefined}
      />,
    );
    const channelSelect = await screen.findByRole("combobox", {
      name: "Discord channel for permission check",
    });

    await waitFor(() => expect(channelSelect).toHaveValue(firstChannelId));
    fireEvent.click(screen.getByRole("button", { name: "Check permissions" }));
    fireEvent.change(channelSelect, { target: { value: secondChannelId } });
    await act(async () => {
      resolveInspection({
        channelId: firstChannelId,
        checkedAt: 1,
        durationMs: 1,
        guildId,
        permissions: [
          {
            granted: false,
            id: "create_public_threads",
            label: "Create Public Threads",
          },
        ],
        status: "ok",
      });
    });
    fireEvent.change(channelSelect, { target: { value: firstChannelId } });

    expect(
      screen.queryByRole("alert", { name: "Discord permission check result" }),
    ).not.toBeInTheDocument();
  });

  it("shows Discord response defaults and inherited override scopes", async () => {
    const snapshot = createSnapshot();
    snapshot.messaging.discord.botToken = {
      configured: true,
      source: "keychain",
      writable: true,
    };
    snapshot.messaging.discord.authorizedGuilds.value = [
      { id: "1480556454498009353", displayName: "PwrAgent test guild" },
    ];
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const discordHeader = screen.getByRole("button", { name: "Discord" });
    if (discordHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(discordHeader);
    }
    const discordSection = discordHeader.closest("section");
    expect(discordSection).not.toBeNull();
    const discordControls = within(discordSection as HTMLElement);

    expect(discordControls.getByText("When PwrAgent responds")).toBeInTheDocument();
    expect(discordControls.getByText("automatic")).toBeInTheDocument();
    expect(
      discordControls.getByRole("textbox", {
        name: "Application ID Override (Advanced)",
      }),
    ).toHaveAttribute("placeholder", "Auto-discovered from bot token");
    // Exact channel and native-thread behavior now lives beside Routes with a
    // named surface picker, so the Discord screen offers no raw-ID editor.
    expect(
      discordControls.queryByText("Channel / Thread Response Overrides"),
    ).toBeNull();
    expect(
      discordControls.getByRole("combobox", {
        name: "Authorized Servers responds to 1",
      }),
    ).toBeInTheDocument();

    fireEvent.click(
      discordControls.getByRole("radio", { name: "@ mention only" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          discord: {
            responseMode: "mention_only",
          },
        },
      });
    });
  });

  it("names Discord servers and scopes the response control to the server", async () => {
    const snapshot = createSnapshot();
    snapshot.messaging.discord.botToken = {
      configured: true,
      source: "keychain",
      writable: true,
    };
    snapshot.messaging.discord.authorizedGuilds.value = [
      { id: "1480556454498009353", displayName: "Test server" },
    ];
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const discordHeader = screen.getByRole("button", { name: "Discord" });
    if (discordHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(discordHeader);
    }
    const discordControls = within(discordHeader.closest("section") as HTMLElement);

    expect(discordControls.getByText("Authorized Servers")).toBeInTheDocument();
    expect(discordControls.queryByText("Authorized Guilds")).toBeNull();
    // Authorization is whole-server, and the copy has to say so rather than
    // implying a row only covers the channel an operator happened to see.
    expect(
      discordControls.getByText(/covers every channel and native thread/i),
    ).toBeInTheDocument();

    // The tooltip is shared with Slack and Telegram rows, so it has to name
    // the row's own scope instead of always claiming "this channel".
    const responseControl = discordControls.getByRole("combobox", {
      name: "Authorized Servers responds to 1",
    });
    expect(responseControl).toHaveAttribute(
      "title",
      expect.stringContaining("in this server"),
    );
    expect(responseControl.getAttribute("title")).not.toContain("this channel");
    expect(responseControl).toHaveAttribute(
      "title",
      expect.stringContaining("does not choose an Agent or authorize access"),
    );
  });

  it("refreshes server names without disturbing other row settings", async () => {
    const snapshot = createSnapshot();
    snapshot.messaging.discord.botToken = {
      configured: true,
      source: "keychain",
      writable: true,
    };
    snapshot.messaging.discord.authorizedGuilds.value = [
      {
        id: "1480556454498009353",
        displayName: "stale-name",
        responseMode: "every_message",
      },
      { id: "1480556454498009354", displayName: "kept-name" },
    ];
    const settings = createSettingsState(snapshot);
    const resolveMessagingContact = vi.fn(async (request: { id: string }) =>
      request.id === "1480556454498009353"
        ? {
            status: "ok" as const,
            id: request.id,
            displayName: "resolved-name",
          }
        : { status: "not_found" as const, id: request.id });

    const { rerender } = render(
      <SettingsScreen
        desktopApi={{ resolveMessagingContact } as never}
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const discordHeader = screen.getByRole("button", { name: "Discord" });
    if (discordHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(discordHeader);
    }
    const discordControls = within(discordHeader.closest("section") as HTMLElement);

    fireEvent.click(
      discordControls.getByRole("button", { name: "Refresh server names" }),
    );

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalled();
    });

    // Only the resolved row is renamed. The failed lookup keeps its stored
    // name, and every row keeps its ID, order, and response setting.
    expect(settings.writeConfig).toHaveBeenCalledWith({
      messaging: {
        discord: {
          authorizedGuilds: [
            {
              id: "1480556454498009353",
              displayName: "resolved-name",
              responseMode: "every_message",
            },
            { id: "1480556454498009354", displayName: "kept-name" },
          ],
        },
      },
    });
    expect(resolveMessagingContact).toHaveBeenCalledTimes(2);
    // One save for the whole pass, not one per resolved row.
    expect(settings.writeConfig).toHaveBeenCalledTimes(1);
    const summary =
      "Checked 2 IDs. Updated 1 name. 1 lookup failed and was left unchanged."
      + " No matching platform identity was found.";
    expect(await discordControls.findByText(summary)).toBeInTheDocument();

    // The real writeConfig resolves by replacing the snapshot, which hands the
    // list a brand-new `value` array. The summary has to survive that: it
    // reports the save that caused it, and it names the row that failed.
    const saved = createSnapshot();
    saved.messaging.discord.botToken = snapshot.messaging.discord.botToken;
    saved.messaging.discord.authorizedGuilds.value = [
      {
        id: "1480556454498009353",
        displayName: "resolved-name",
        responseMode: "every_message",
      },
      { id: "1480556454498009354", displayName: "kept-name" },
    ];
    rerender(
      <SettingsScreen
        desktopApi={{ resolveMessagingContact } as never}
        settings={{ ...settings, snapshot: saved }}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    expect(discordControls.getByText(summary)).toBeInTheDocument();
  });

  it("disables Discord mention modes until a bot identity can be resolved", () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const discordHeader = screen.getByRole("button", { name: "Discord" });
    if (discordHeader.getAttribute("aria-expanded") !== "true") {
      fireEvent.click(discordHeader);
    }
    const discordControls = within(discordHeader.closest("section") as HTMLElement);

    expect(
      discordControls.getByRole("radio", { name: "@ mention only" }),
    ).toBeDisabled();
    expect(
      discordControls.queryByText("Channel / Thread Response Overrides"),
    ).not.toBeInTheDocument();
  });

  it("shows a leftover Events API notice and persists Socket Mode", async () => {
    const snapshot = createSnapshot();
    snapshot.messaging.slack.inboundMode = { value: "events", source: "config" };
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="slack"
        onClose={() => undefined}
      />,
    );

    expect(
      screen.getByText("Events API is not implemented. PwrAgent will use Socket Mode."),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Socket Mode" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByRole("radio", { name: "Events API" })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            inboundMode: "socket",
          },
        },
      });
    });
  });

  it("sanitizes manually entered messaging display names before saving", async () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    fireEvent.change(screen.getByLabelText("Authorized User IDs ID 1"), {
      target: { value: "8460800771" },
    });
    fireEvent.change(
      screen.getByLabelText("Authorized User IDs display name 1"),
      {
        target: {
          value: "<script>alert(1)</script>Harold\u202e",
        },
      },
    );
    fireEvent.blur(screen.getByLabelText("Authorized User IDs display name 1"));

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [
              { id: "8460800771", displayName: "Harold" },
            ],
          },
        },
      });
    });
  });

  it("ignores stale lookup results after an authorized ID is removed", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          authorizedUserIds: {
            value: [{ id: "8460800771", displayName: "" }],
            source: "config",
          },
        },
      },
    });
    let resolveLookup:
      | ((value: {
          status: "ok";
          id: string;
          displayName: string;
        }) => void)
      | undefined;
    const resolveMessagingContact = vi.fn(
      () =>
        new Promise<{
          status: "ok";
          id: string;
          displayName: string;
        }>((resolve) => {
          resolveLookup = resolve;
        }),
    );
    const desktopApi = {
      resolveMessagingContact,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Lookup Authorized User IDs row 1",
      }),
    );

    await waitFor(() => {
      expect(resolveMessagingContact).toHaveBeenCalledWith({
        platform: "telegram",
        kind: "user",
        id: "8460800771",
      });
    });
    const removeButton = await screen.findByRole("button", {
      name: "Remove Authorized User IDs row 1",
    });
    expect(removeButton).toBeEnabled();
    fireEvent.click(removeButton);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [],
          },
        },
      });
    });

    const writeConfig = settings.writeConfig as ReturnType<typeof vi.fn>;
    const callsBeforeLookupResolution = writeConfig.mock.calls.length;
    await act(async () => {
      resolveLookup?.({
        status: "ok",
        id: "8460800771",
        displayName: "Harold (@fixtureuser)",
      });
    });

    expect(writeConfig).toHaveBeenCalledTimes(callsBeforeLookupResolution);
    expect(writeConfig).not.toHaveBeenCalledWith({
      messaging: {
        telegram: {
          authorizedUserIds: [
            { id: "8460800771", displayName: "Harold (@fixtureuser)" },
          ],
        },
      },
    });
  });

  it("surfaces invalid persisted messaging IDs with a Remove action", async () => {
    const snapshot = createSnapshot();
    const settings = createSettingsState({
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          authorizedUserIds: {
            value: [
              { id: "@fixtureuser", displayName: "Wrong person" },
              { id: "8460800771", displayName: "Harold" },
            ],
            source: "config",
          },
        },
      },
    });

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
        initialSubsection="telegram"
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("@fixtureuser")).toBeInTheDocument();
    expect(screen.getByText(/That looks like a Telegram username/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove Authorized User IDs row 1",
      }),
    );

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [{ id: "8460800771", displayName: "Harold" }],
          },
        },
      });
    });
  });

  it("returns to the previous app surface", () => {
    const onClose = vi.fn();
    render(<SettingsScreen settings={createSettingsState()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /Exit Settings/i }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("manages PwrAgent profiles from Settings", async () => {
    let defaultProfile = "default";
    let profileNames = ["dev", "default", "scratch"];
    const listPwrAgentProfiles = vi.fn(async () => ({
      activeProfile: "dev",
      defaultProfile,
      profiles: profileNames.map((name) => ({
        name,
        displayName: name,
        lastUsed: name === "scratch" ? undefined : "2026-05-13T12:00:00.000Z",
        active: name === "dev",
        default: name === defaultProfile,
        profileDir: `/home/example/.pwragent/profiles/${name}`,
        canDelete: name !== "dev" && name !== "default",
        codexProfile: {
          name: name === "scratch" ? "work" : "",
          displayName: name === "scratch" ? "work" : "System default",
          codexHome:
            name === "scratch"
              ? "/home/example/.codex/profiles/work"
              : "/home/example/.codex",
          source: name === "scratch" ? "directory" : "default",
          exists: true,
          selected: true,
          hasAuthFile: true,
          hasConfigFile: name !== "scratch",
        },
      })),
    }));
    const setDefaultPwrAgentProfile = vi.fn(async ({ profile }: { profile: string }) => {
      defaultProfile = profile;
      return { profile };
    });
    const deletePwrAgentProfile = vi.fn(async ({ profile }: { profile: string }) => {
      profileNames = profileNames.filter((name) => name !== profile);
      if (defaultProfile === profile) defaultProfile = "default";
      return { deleted: true, profile };
    });
    const openPwrAgentProfile = vi.fn(async ({ profile }: { profile: string }) => ({
      opened: true,
      profile,
    }));
    const createPwrAgentProfile = vi.fn(async ({ profile }: { profile: string }) => {
      profileNames = [...profileNames, profile];
      return {
        profile,
        profileDir: `/home/example/.pwragent/profiles/${profile}`,
        created: true,
      };
    });
    const setPwrAgentProfileCodexProfile = vi.fn(
      async (request: { profile: string; codexProfile: string }) => request,
    );
    const desktopApi = {
      createPwrAgentProfile,
      deletePwrAgentProfile,
      listPwrAgentProfiles,
      openPwrAgentProfile,
      platform: "darwin",
      setDefaultPwrAgentProfile,
      setPwrAgentProfileCodexProfile,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    const { container } = render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="profiles"
        settings={createSettingsState()}
      onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Add profile" }));
    const createDialog = await screen.findByRole("dialog", {
      name: "Add PwrAgent profile",
    });
    expect(createDialog).not.toHaveClass("settings-confirm-dialog--danger");
    fireEvent.change(
      within(createDialog).getByRole("textbox", {
        name: "PwrAgent profile name",
      }),
      { target: { value: "My Work" } },
    );
    expect(within(createDialog).getByText("my-work")).toBeInTheDocument();
    fireEvent.click(within(createDialog).getByRole("button", { name: "Add profile" }));
    await waitFor(() => {
      expect(createPwrAgentProfile).toHaveBeenCalledWith({ profile: "my-work" });
    });

    expect(await screen.findByText("scratch")).toBeInTheDocument();
    expect(
      screen.getByTitle("/home/example/.pwragent/profiles/dev"),
    ).toBeInTheDocument();

    const scratchRow = screen
      .getByText("scratch")
      .closest(".settings-profile-card") as HTMLElement;
    expect(
      within(scratchRow).getByRole("combobox", {
        name: "Codex auth profile for scratch",
      }),
    ).toHaveValue("work");
    fireEvent.change(
      within(scratchRow).getByRole("combobox", {
        name: "Codex auth profile for scratch",
      }),
      { target: { value: "" } },
    );
    await waitFor(() => {
      expect(setPwrAgentProfileCodexProfile).toHaveBeenCalledWith({
        profile: "scratch",
        codexProfile: "",
      });
    });

    fireEvent.click(within(scratchRow).getByRole("button", { name: "Use on startup" }));
    await waitFor(() => {
      expect(setDefaultPwrAgentProfile).toHaveBeenCalledWith({
        profile: "scratch",
      });
    });

    fireEvent.click(within(scratchRow).getByRole("button", { name: "Open" }));
    await waitFor(() => {
      expect(openPwrAgentProfile).toHaveBeenCalledWith({ profile: "scratch" });
    });

    fireEvent.click(within(scratchRow).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete profile?" });
    expect(dialog).toHaveClass("settings-confirm-dialog--danger");
    expect(dialog).toHaveTextContent("Move scratch to Trash.");
    expect(dialog).toHaveTextContent("Close any other PwrAgent windows using this profile first.");
    expect(dialog).toHaveTextContent("Codex auth homes under ~/.codex are not deleted.");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Move profile to Trash" }),
    );

    await waitFor(() => {
      expect(deletePwrAgentProfile).toHaveBeenCalledWith({ profile: "scratch" });
    });
    await waitFor(() => {
      expect(container.querySelector(".settings-confirm-dialog")).toBeNull();
    });
  });

  it("uses shared PwrAgent profile state from the app shell", async () => {
    const setDefaultProfile = vi.fn(async () => undefined);
    render(
      <SettingsScreen
        initialSection="profiles"
        profiles={{
          activeProfile: "dev",
          createProfile: vi.fn(async () => undefined),
          defaultProfile: "default",
          deleteProfile: vi.fn(async () => undefined),
          loading: false,
          openProfile: vi.fn(async () => undefined),
          profiles: [
            {
              name: "dev",
              displayName: "dev",
              active: true,
              default: false,
              profileDir: "/home/example/.pwragent/profiles/dev",
              canDelete: false,
              codexProfile: {
                name: "",
                displayName: "System default",
                codexHome: "/home/example/.codex",
                source: "default",
                exists: true,
                selected: true,
                hasAuthFile: true,
                hasConfigFile: true,
              },
            },
            {
              name: "work",
              displayName: "work",
              active: false,
              default: false,
              profileDir: "/home/example/.pwragent/profiles/work",
              canDelete: true,
              codexProfile: {
                name: "",
                displayName: "System default",
                codexHome: "/home/example/.codex",
                source: "default",
                exists: true,
                selected: true,
                hasAuthFile: true,
                hasConfigFile: true,
              },
            },
          ],
          refresh: vi.fn(async () => undefined),
          setCodexProfile: vi.fn(async () => undefined),
          setDefaultProfile,
        }}
        settings={createSettingsState()}
      />,
    );

    // The path renders as a head + pinned tail pair for middle
    // truncation, so its text is split across two spans; the container
    // carries the untruncated value on `title`.
    const workRow = screen
      .getByTitle("/home/example/.pwragent/profiles/work")
      .closest(".settings-profile-card") as HTMLElement;
    fireEvent.click(within(workRow).getByRole("button", { name: "Use on startup" }));

    await waitFor(() => {
      expect(setDefaultProfile).toHaveBeenCalledWith("work");
    });
  });

  it("renders About license attribution and opens bundled notices", async () => {
    const openChangelogWindow = vi.fn(async () => undefined);
    const openThirdPartyNoticesWindow = vi.fn(async () => undefined);
    const readLicenseDocument = vi.fn(async (kind: string) => ({
      kind,
      title: kind === "license" ? "MIT License" : "Third-Party Notices",
      content:
        kind === "license"
          ? "MIT License\n\nPermission is hereby granted."
          : "PwrAgent Third-Party Notices\n\nreact@19.2.5",
    }));
    const desktopApi = {
      readAppMetadata: vi.fn(async () => ({
        applicationName: "PwrAgent",
        applicationVersion: "1.0.0-alpha.8",
        copyright: "Copyright © 2026 PwrDrvr LLC.",
        homepage: "https://pwragent.ai",
        documentationUrl: "https://docs.pwragent.ai",
        electronVersion: "41.2.1",
        chromeVersion: "142.0.0.0",
        nodeVersion: "24.0.0",
      })),
      openChangelogWindow,
      openThirdPartyNoticesWindow,
      readLicenseDocument,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="about"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("PwrAgent is licensed under MIT.")).toBeInTheDocument();
    expect(screen.getByText("https://pwragent.ai")).toBeInTheDocument();
    expect(screen.getByText("https://docs.pwragent.ai")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open changelog" }));
    expect(openChangelogWindow).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Third-party notices" }));
    expect(openThirdPartyNoticesWindow).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "View MIT license" }));

    await waitFor(() => {
      expect(readLicenseDocument).toHaveBeenCalledWith("license");
    });
    expect(await screen.findByLabelText("MIT License")).toHaveTextContent(
      "Permission is hereby granted.",
    );
  });

  it("renders the chrome with brand in the nav masthead and breadcrumb + MessagingStatusBar in the right-pane title bar", async () => {
    // Lock the new chrome contract: brand sits in the LEFT nav's
    // `__masthead` (mirrors `.sidebar__masthead` on the main app
    // screen). Right-pane title bar (`.settings-titlebar`) carries
    // breadcrumb + MessagingStatusBar but NO brand. The previous
    // "duplicate brand + giant tangerine 'Settings' h1" mini-shell
    // is gone. Stub the platform-status hook so MessagingStatusBar
    // has at least one platform to render.
    const desktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => [
        {
          platform: "slack" as const,
          health: "enabled" as const,
          changedAt: 0,
        },
      ]),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    const { container } = render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    // Old `.settings-header` is gone; new `.settings-titlebar` is in.
    expect(container.querySelector(".settings-titlebar")).not.toBeNull();
    expect(container.querySelector(".settings-header")).toBeNull();

    // Brand lives in the nav masthead (left column), NOT inside the
    // title bar. Brand text + accent split.
    const brandAccent = container.querySelector(
      ".settings-nav__brand-accent",
    );
    expect(brandAccent).not.toBeNull();
    expect(brandAccent?.closest(".settings-nav__masthead")).not.toBeNull();
    expect(brandAccent?.closest(".settings-titlebar")).toBeNull();

    // The 34px tangerine "Settings" h1 from the old chrome is gone.
    // Each pane now renders its own per-pane head (eyebrow + 22px h1
    // + helper paragraph) per the v2 design — but that h1 lives in
    // `.settings-content`, NEVER in the title-bar strip.
    const headings = screen.queryAllByRole("heading", { level: 1 });
    for (const heading of headings) {
      expect(heading.closest(".settings-titlebar")).toBeNull();
    }

    // MessagingStatusBar is mounted in the title-bar strip's actions
    // slot; wait for the async platform-status hook to resolve.
    await waitFor(() => {
      const bar = container.querySelector(".messaging-status-bar");
      expect(bar).not.toBeNull();
      // Specifically inside the title-bar strip, not the nav.
      expect(bar?.closest(".settings-titlebar")).not.toBeNull();
      expect(bar?.querySelector("img")).not.toBeNull();
      expect(bar?.querySelector(".messaging-status-chip__fallback")).toBeNull();
    });
  });

  it("shows the active section's label in the breadcrumb's current slot", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const current = document.querySelector(".settings-titlebar__current");
    expect(current).not.toBeNull();
    expect(current?.textContent).toBe("Messaging");
  });

  it("fires onOpenMessagingActivity from the title-bar messaging popover", async () => {
    // Activity is its own top-level mainView, NOT a settings section,
    // so a chip click in the Settings title-bar strip delegates to
    // App.tsx via this callback. The App-level handler closes the
    // Settings overlay and opens the Messaging Activity overlay.
    const desktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => [
        {
          platform: "telegram" as const,
          health: "enabled" as const,
          changedAt: 0,
        },
      ]),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];
    const onOpenMessagingActivity = vi.fn();

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={createSettingsState()}
        onClose={() => undefined}
        onOpenMessagingActivity={onOpenMessagingActivity}
      />,
    );

    const chip = await screen.findByRole("button", { name: /Telegram/i });
    fireEvent.click(chip);
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Messaging Activity" }),
    );

    await waitFor(() => {
      expect(onOpenMessagingActivity).toHaveBeenCalledWith(undefined);
    });
    // The breadcrumb stays on whatever section was active — chip
    // clicks no longer mutate the section selection.
    const current = document.querySelector(".settings-titlebar__current");
    expect(current?.textContent).not.toBe("Messaging activity");
  });

  it("opens the Messaging section from the title-bar popover gear", async () => {
    const desktopApi = {
      getMessagingPlatformStatuses: vi.fn(async () => [
        {
          platform: "telegram" as const,
          health: "enabled" as const,
          changedAt: 0,
        },
      ]),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /Telegram/i }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open Messaging Settings" }),
    );

    await waitFor(() => {
      expect(document.querySelector(".settings-titlebar__current")).toHaveTextContent(
        "Messaging",
      );
    });
    expect(
      screen.getByRole("button", { name: "Messaging" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("keeps Exit, the General label, and section order in the settings nav", () => {
    // Regression lock for the design contract: Exit Settings lives
    // INSIDE `.settings-nav` (left column), not inside the title-bar
    // strip. Two prior attempts in this branch put it in the strip
    // and were reset.
    render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const exit = screen.getByRole("button", { name: /Exit Settings/i });
    expect(exit.closest(".settings-nav")).not.toBeNull();
    expect(exit.closest(".settings-titlebar")).toBeNull();
    expect(exit).toHaveClass("settings-nav__exit");

    const label = document.querySelector(".settings-nav__group-label");
    expect(label).not.toBeNull();
    expect(label?.textContent?.toLowerCase()).toBe("general");

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    // Caret toggles sit beside the group labels and sub-items live in
    // collapsed sublists; the order contract is about section labels.
    const buttons = Array.from(
      nav.querySelectorAll(".settings-nav__exit, .settings-nav__button"),
    ).map((button) => button.textContent);
    expect(buttons).toEqual([
      "← Exit Settings",
      "General",
      "Applications",
      "Plugins",
      "Profiles",
      "AI Providers",
      "Usage & Pricing",
      "Messaging",
      "Federation",
      "Access Control",
      "Git",
      "Worktrees",
      "Thread Management",
      "Archived Threads",
      "Experimental",
      "Troubleshooting",
      "About",
    ]);
    // The three group sections expand; every other row keeps the caret
    // gutter so labels stay aligned.
    const caretLabels = Array.from(
      nav.querySelectorAll(".settings-nav__caret"),
    ).map((button) => button.getAttribute("aria-label"));
    expect(caretLabels).toEqual([
      "Expand Plugins",
      "Expand AI Providers",
      "Expand Messaging",
    ]);
    // Collapsed sublists keep their children out of the accessibility
    // tree — MCPs only appears once Plugins expands.
    expect(
      within(nav).queryByRole("button", { name: "MCPs" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(nav).getByRole("button", { name: "Expand Plugins" }),
    );
    expect(
      within(nav).getByRole("button", { name: "MCPs" }),
    ).toBeInTheDocument();
    expect(within(nav).getByRole("separator")).toHaveClass(
      "settings-nav__divider",
    );
  });

  it("expands a nav group from the caret without navigating", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const caret = within(nav).getByRole("button", {
      name: "Expand AI Providers",
    });
    fireEvent.click(caret);

    // Expanded, but still on General — the caret only discloses.
    expect(within(nav).getByRole("button", { name: "Codex" }))
      .toBeInTheDocument();
    expect(
      document.querySelector(".settings-titlebar__current")?.textContent,
    ).toBe("General");
    expect(within(nav).getByRole("button", { name: "General" }))
      .toHaveAttribute("aria-current", "page");

    fireEvent.click(
      within(nav).getByRole("button", { name: "Collapse AI Providers" }),
    );
    expect(
      within(nav).queryByRole("button", { name: "Codex" }),
    ).not.toBeInTheDocument();
  });

  it("navigates and expands together when a group label is clicked", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Messaging" }));

    expect(within(nav).getByRole("button", { name: "Messaging" }))
      .toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("button", { name: "Telegram" }))
      .toBeInTheDocument();
    expect(
      document.querySelector(".settings-titlebar__current")?.textContent,
    ).toBe("Messaging");
  });

  it("opens a focused provider screen and returns through the breadcrumb", () => {
    render(
      <SettingsScreen
        initialSection="models"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(nav).getByRole("button", { name: "Codex" }));

    expect(within(nav).getByRole("button", { name: "Codex" }))
      .toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("region", { name: "Codex provider settings" }),
    ).toBeInTheDocument();
    // The defaults cross-link keeps the hub's answer one click away.
    expect(
      screen.getByRole("note", { name: "New thread defaults summary" }),
    ).toBeInTheDocument();

    // Breadcrumb: Settings › AI Providers › Codex, with a clickable
    // parent crumb back to the hub.
    expect(
      document.querySelector(".settings-titlebar__current")?.textContent,
    ).toBe("Codex");
    const crumb = document.querySelector(".settings-titlebar__crumb");
    expect(crumb).toHaveTextContent("AI Providers");
    fireEvent.click(crumb as HTMLElement);
    expect(
      document.querySelector(".settings-titlebar__current")?.textContent,
    ).toBe("AI Providers");
    expect(
      screen.getByRole("region", { name: "Model settings" }),
    ).toBeInTheDocument();
  });

  it("returns to the models hub from a focused screen's Edit defaults action", () => {
    render(
      <SettingsScreen
        initialSection="models"
        initialSubsection="codex"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit defaults" }));
    expect(
      screen.getByRole("region", { name: "Model settings" }),
    ).toBeInTheDocument();
    expect(
      document.querySelector(".settings-titlebar__current")?.textContent,
    ).toBe("AI Providers");
  });

  it("sorts Gemini CLI last and marks disabled providers off in the nav", async () => {
    const baseSnapshot = createSnapshot();
    const snapshot = createSnapshot({
      acpAgents: {
        ...baseSnapshot.acpAgents,
        gemini: { cliPath: { value: "", source: "default" }, enabled: false },
      },
    } as Partial<DesktopSettingsSnapshot>);
    const listAcpAgents = vi.fn(async () => ({
      fetchedAt: 1000,
      entries: [
        {
          backendId: "acp:gemini",
          registryId: "gemini",
          name: "Gemini CLI",
          authors: [],
          distributionKind: "local",
          distributionSource: "gemini --acp",
          installable: false,
          installed: true,
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
        } satisfies AcpAgentSettingsEntry,
        {
          backendId: "acp:grok",
          registryId: "grok",
          name: "Grok",
          authors: [],
          distributionKind: "local",
          distributionSource: "/usr/bin/grok",
          installable: false,
          installed: true,
          installStatus: "installed",
          authStatus: "not-required",
          verificationStatus: "not-applicable",
        } satisfies AcpAgentSettingsEntry,
      ],
    }));

    render(
      <SettingsScreen
        desktopApi={{ listAcpAgents }}
        initialSection="models"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    await within(nav).findByRole("button", { name: /Gemini CLI/ });
    const subLabels = Array.from(
      nav.querySelectorAll("#settings-nav-sublist-models .settings-nav__sublabel"),
    ).map((label) => label.textContent);
    expect(subLabels).toEqual(["Codex", "Grok", "Gemini CLI"]);
    const geminiButton = within(nav).getByRole("button", {
      name: /Gemini CLI/,
    });
    expect(
      geminiButton.querySelector(".settings-nav__subchip")?.textContent,
    ).toBe("off");
    expect(
      geminiButton.querySelector(".settings-nav__subdot--off"),
    ).not.toBeNull();
  });

  it("relogs and removes MCP servers from the Plugins settings pane", async () => {
    const codexHome = "/home/example/.codex";
    const listCodexMcpServers = vi.fn(async () => ({
      codexHome,
      detail: "toolsAndAuthOnly" as const,
      servers: [{
        name: "datadog",
        authStatus: "oAuth" as const,
        startupStatus: "failed" as const,
        startupError: "invalid_grant",
        tools: [],
      }, {
        name: "atlassian",
        authStatus: "oAuth" as const,
        tools: ["search"],
      }],
    }));
    const reloadCodexMcpServers = vi.fn(async () => ({
      codexHome,
      queued: true as const,
    }));
    const startCodexMcpServerLogin = vi.fn(async (request: {
      codexHome: string;
      name: string;
    }) => ({
      codexHome,
      name: request.name,
      authorizationUrl: "https://example.test/datadog-login",
    }));
    const removeCodexMcpServer = vi.fn(async () => ({
      codexHome,
      name: "datadog",
      removed: true as const,
    }));
    let agentEventListener: ((event: AgentEvent) => void) | undefined;
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    render(
      <SettingsScreen
        desktopApi={{
          listCodexMcpServers,
          onAgentEvent: (listener) => {
            agentEventListener = listener;
            return () => undefined;
          },
          reloadCodexMcpServers,
          removeCodexMcpServer,
          startCodexMcpServerLogin,
        }}
        initialSection="plugins"
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("invalid_grant")).toBeInTheDocument();
    const datadogRow = screen.getByText("datadog")
      .closest<HTMLElement>(".settings-mcp-row");
    const atlassianRow = screen.getByText("atlassian")
      .closest<HTMLElement>(".settings-mcp-row");
    expect(datadogRow).not.toBeNull();
    expect(atlassianRow).not.toBeNull();

    // Both servers hold OAuth credentials, so neither row carries a bare
    // "Sign in" button — that is promoted only for `notLoggedIn`. Signing in
    // again, and removing, live in the row's overflow menu so the destructive
    // verb is not the pane's most available control.
    fireEvent.click(
      within(datadogRow!).getByRole("button", { name: "More actions for datadog" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Sign in to datadog again" }),
    );
    expect(
      within(atlassianRow!).getByRole("button", {
        name: "More actions for atlassian",
      }),
    ).toBeDisabled();
    await waitFor(() => {
      expect(startCodexMcpServerLogin).toHaveBeenCalledWith({
        codexHome,
        name: "datadog",
      });
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.test/datadog-login",
        "_blank",
        "noopener,noreferrer",
      );
    });

    await act(async () => {
      agentEventListener?.({
        backend: "codex",
        notification: {
          method: "mcpServer/oauthLogin/completed",
          params: { name: "datadog", success: true },
        },
      });
    });
    expect(
      within(atlassianRow!).getByRole("button", {
        name: "More actions for atlassian",
      }),
    ).toBeDisabled();
    await act(async () => {
      agentEventListener?.({
        backend: "codex",
        notification: {
          method: "mcpServer/startupStatus/updated",
          params: { name: "datadog", status: "ready" },
        },
      });
    });
    expect(await screen.findByText(
      "datadog signed in and its row was refreshed.",
    )).toBeInTheDocument();
    expect(reloadCodexMcpServers).toHaveBeenCalledWith({ codexHome });

    fireEvent.click(
      within(datadogRow!).getByRole("button", { name: "More actions for datadog" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove datadog" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove server" }));
    await waitFor(() => {
      expect(removeCodexMcpServer).toHaveBeenCalledWith({
        codexHome,
        name: "datadog",
      });
      expect(screen.getByText(
        "datadog was removed from this Codex profile.",
      )).toBeInTheDocument();
    });

    fireEvent.click(
      within(atlassianRow!).getByRole("button", {
        name: "More actions for atlassian",
      }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Sign in to atlassian again" }),
    );
    expect(await screen.findByRole("button", { name: "Cancel sign-in" }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel sign-in" }));
    expect(await screen.findByText(
      "Stopped waiting for sign-in. You can try again.",
    )).toBeInTheDocument();
    expect(
      within(datadogRow!).getByRole("button", { name: "More actions for datadog" }),
    ).toBeEnabled();
  });

  it("disables MCP mutations when the selected Codex profile changed after startup", async () => {
    const base = createSnapshot();
    const workCodexHome = "/home/example/.codex/profiles/work";
    const snapshot = createSnapshot({
      models: {
        ...base.models,
        codex: {
          ...base.models.codex,
          profile: { value: "work", source: "config" },
          profiles: {
            ...base.models.codex.profiles,
            effectiveCodexHome: workCodexHome,
            profiles: base.models.codex.profiles.profiles.map((profile) => ({
              ...profile,
              selected: profile.name === "work",
            })),
          },
        },
      },
    });

    render(
      <SettingsScreen
        desktopApi={{
          listCodexMcpServers: vi.fn(async () => ({
            codexHome: "/home/example/.codex",
            detail: "toolsAndAuthOnly" as const,
            servers: [{
              name: "atlassian",
              authStatus: "oAuth" as const,
              tools: ["search"],
            }],
          })),
          reloadCodexMcpServers: vi.fn(),
          removeCodexMcpServer: vi.fn(),
          startCodexMcpServerLogin: vi.fn(),
        }}
        initialSection="plugins"
        settings={createSettingsState(snapshot)}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText(
      "Codex profile selection changed to work. Restart PwrAgent before managing MCP servers for that profile.",
    )).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload config" })).toBeDisabled();
    // Every mutation is behind the row overflow now, so disabling that button
    // is what closes off Sign in and Remove together.
    expect(
      screen.getByRole("button", { name: "More actions for atlassian" }),
    ).toBeDisabled();
    expect(screen.getByText("~/.codex")).toBeInTheDocument();
  });

  it("shows when messaging is disabled by a runtime override", () => {
    render(
      <SettingsScreen
        settings={createSettingsState(
          createSnapshot({
            runtime: {
              messaging: {
                disabled: true,
                overrideActive: true,
                disabledReason: "--disable-messaging was provided at startup",
              },
            },
          }),
        )}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Messaging disabled for this app instance",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "The override applies to this session only",
    );
  });

  it("persists the master messaging switch when no runtime override is active", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
    fireEvent.click(screen.getByRole("switch", { name: "Messaging" }));

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: { enabled: false },
      });
    });
  });

  it("persists messaging Full Access policy controls", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
    fireEvent.click(
      screen.getByRole("switch", { name: "Resume Full Access threads" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: { allowFullAccessThreadResume: false },
      });
    });

    fireEvent.click(screen.getByRole("switch", { name: "Escalate to Full Access" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: { allowFullAccessEscalation: false },
      });
    });

    fireEvent.click(screen.getByRole("radio", { name: "Always warn" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: { fullAccessWarning: "always" },
      });
    });
  });

  it("uses a session-only master messaging switch when the runtime override is active", async () => {
    const setMessagingEnabled = vi.fn(async () => ({
      enabled: true,
      overridden: true,
      overrideReason: "--disable-messaging was provided at startup",
    }));
    const settings = createSettingsState(
      createSnapshot({
        runtime: {
          messaging: {
            disabled: true,
            overrideActive: true,
            disabledReason: "--disable-messaging was provided at startup",
          },
        },
      }),
    );
    render(
      <SettingsScreen
        desktopApi={{ setMessagingEnabled }}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
    fireEvent.click(screen.getByRole("switch", { name: "Messaging" }));

    await waitFor(() => {
      expect(setMessagingEnabled).toHaveBeenCalledWith({ enabled: true });
      expect(settings.refresh).toHaveBeenCalled();
    });
    expect(settings.writeConfig).not.toHaveBeenCalledWith({
      messaging: { enabled: true },
    });
  });

  it("keeps a secret draft when replacement fails", async () => {
    const settings = createSettingsState();
    settings.replaceSecret = vi.fn(async () => false);
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Telegram settings" }),
    );
    const tokenInput = screen.getAllByLabelText("Bot Token")[0];
    fireEvent.change(tokenInput, {
      target: { value: "123456789:secret-token" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]);

    await waitFor(() => {
      expect(settings.replaceSecret).toHaveBeenCalledWith(
        "telegramBotToken",
        "123456789:secret-token",
      );
    });
    expect(tokenInput).toHaveValue("123456789:secret-token");
  });

  it("lets users discard an unsaved secret draft", () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Messaging" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open Telegram settings" }),
    );
    const tokenInput = screen.getAllByLabelText("Bot Token")[0];
    fireEvent.change(tokenInput, {
      target: { value: "123456789:secret-token" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);

    expect(tokenInput).toHaveValue("");
    expect(settings.replaceSecret).not.toHaveBeenCalled();
  });

  it("offers a switch back when the downloaded release is older than the running build", async () => {
    const settings = createSettingsState(
      createSnapshot({
        updates: {
          channel: { value: "latest", source: "config" },
          train: { value: "stable", source: "config" },
          selectionSource: "user",
        },
      }),
    );
    const desktopApi = {
      checkForAppUpdates: vi.fn(async () => ({
        status: "available" as const,
        version: "1.0.2",
        direction: "downgrade" as const,
      })),
      readAppUpdateReleaseVersions: vi.fn(async () => ({
        fetchedAt: 1,
        stable: {
          latest: { version: "v1.0.2" },
          prerelease: { version: "v1.0.2" },
        },
        beta: {
          latest: { version: "v1.1.0-alpha.2" },
          prerelease: { version: "v1.1.0-alpha.2" },
        },
      })),
      readAppUpdateStatus: vi.fn(async () => ({
        status: "downloaded" as const,
        version: "1.0.2",
        direction: "downgrade" as const,
      })),
      installAppUpdate: vi.fn(async () => ({ status: "restarting" as const })),
    };

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(
      await screen.findByRole("button", {
        name: "Restart to Switch (1.0.2)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Restart to Update (1.0.2)" }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Check for Update" }));
    await waitFor(() => {
      expect(desktopApi.checkForAppUpdates).toHaveBeenCalledTimes(1);
    });
    expect(await screen.findByText(/Switch to v1.0.2/)).toBeInTheDocument();
  });

  it("shows a restart action when the selected channel version is already downloaded", async () => {
    const settings = createSettingsState(
      createSnapshot({
        updates: {
          channel: { value: "prerelease", source: "config" },
          train: { value: "stable", source: "default" },
          selectionSource: "user",
        },
      }),
    );
    const desktopApi = {
      checkForAppUpdates: vi.fn(async () => ({
        status: "available" as const,
        version: "1.0.0-beta.8",
      })),
      readAppUpdateReleaseVersions: vi.fn(async () => ({
        fetchedAt: 1,
        stable: {
          latest: { version: "v1.0.0" },
          prerelease: { version: "v1.0.0-beta.7" },
        },
        beta: {
          latest: { version: "v1.1.0-beta.2" },
          prerelease: { version: "v1.1.0-alpha.7" },
        },
      })),
      readAppUpdateStatus: vi.fn(async () => ({
        status: "downloaded" as const,
        version: "1.0.0-beta.7",
      })),
      installAppUpdate: vi.fn(async () => ({ status: "restarting" as const })),
    };

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    expect(await screen.findByText("v1.0.0-beta.7")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Restart to Update (1.0.0-beta.7)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Downloaded version: 1.0.0-beta.7"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Restart to Update (1.0.0-beta.7)",
      }),
    );
    await waitFor(() => {
      expect(desktopApi.installAppUpdate).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "Check for Update" }));
    await waitFor(() => {
      expect(desktopApi.checkForAppUpdates).toHaveBeenCalledTimes(1);
    });
    expect(
      await screen.findByText(/Update available: v1.0.0-beta.8/),
    ).toBeInTheDocument();
    expect(desktopApi.readAppUpdateStatus).toHaveBeenCalledTimes(1);
  });

  it("configures GitHub Auto-fix PR and gates it on background PR status", async () => {
    const settings = createSettingsState();
    render(
      <SettingsScreen
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    const allowAutoFix = screen.getByRole("switch", {
      name: "Allow Auto-fix PR",
    });
    const defaultAutoFix = screen.getByRole("switch", {
      name: "Enable Auto-fix PR for new threads and launchpads",
    });
    expect(allowAutoFix).toHaveAttribute("aria-checked", "true");
    expect(defaultAutoFix).toHaveAttribute("aria-checked", "true");
    const budgetCapacity = screen.getByLabelText("Automatic repair capacity");
    const budgetRefill = screen.getByLabelText("Automatic repair refill rate");
    const pauseWhenEmpty = screen.getByRole("switch", {
      name: "Pause Auto-fix PR when the budget is empty",
    });
    expect(budgetCapacity).toHaveValue(30);
    expect(budgetRefill).toHaveValue(1);
    expect(pauseWhenEmpty).toHaveAttribute("aria-checked", "true");

    fireEvent.click(allowAutoFix);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { prAutoDispatchAllowed: false },
      });
    });
    fireEvent.click(defaultAutoFix);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { defaultPrAutoDispatchEnabled: false },
      });
    });
    fireEvent.change(budgetCapacity, { target: { value: "42" } });
    fireEvent.blur(budgetCapacity);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { prAutoDispatchBudgetCapacity: 42 },
      });
    });
    fireEvent.change(budgetRefill, { target: { value: "3" } });
    fireEvent.blur(budgetRefill);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { prAutoDispatchBudgetRefillPerMinute: 3 },
      });
    });
    fireEvent.click(pauseWhenEmpty);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        git: { pausePrAutoDispatchWhenBudgetEmpty: false },
      });
    });

    const baseSnapshot = createSnapshot();
    const backgroundOffSettings = createSettingsState(
      createSnapshot({
        git: {
          ...baseSnapshot.git,
          backgroundPrPolling: { value: false, source: "config" },
        },
      }),
    );
    cleanup();
    render(
      <SettingsScreen
        initialSection="git"
        settings={backgroundOffSettings}
        onClose={() => undefined}
      />,
    );

    expect(
      screen.getByRole("switch", { name: "Allow Auto-fix PR" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("switch", {
        name: "Enable Auto-fix PR for new threads and launchpads",
      }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Apply to launchpads" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Enable existing PR threads…" }),
    ).toBeDisabled();
  });

  it("applies Auto-fix PR defaults to launchpads and eligible existing threads", async () => {
    const settings = createSettingsState();
    const getNavigationSnapshot = vi.fn(async () => ({
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      directories: [
        {
          key: "directory:/repo-a",
          kind: "directory" as const,
          label: "Repo A",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/repo-a",
            directoryKind: "directory" as const,
            directoryLabel: "Repo A",
            backend: "codex" as const,
            executionMode: "default" as const,
            workMode: "local" as const,
            prompt: "",
            createdAt: 1,
            updatedAt: 1,
          },
        },
        {
          key: "directory:/repo-b",
          kind: "directory" as const,
          label: "Repo B",
          threadKeys: [],
          needsAttentionCount: 0,
          launchpad: {
            directoryKey: "directory:/repo-b",
            directoryKind: "directory" as const,
            directoryLabel: "Repo B",
            backend: "codex" as const,
            executionMode: "default" as const,
            workMode: "local" as const,
            prompt: "",
            createdAt: 1,
            updatedAt: 1,
          },
        },
      ],
      inboxThreadKeys: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
      threads: [],
    }));
    const updateDirectoryLaunchpad = vi.fn(async (request) => ({
      launchpad: {
        directoryKey: request.directoryKey,
        directoryKind: "directory" as const,
        directoryLabel: request.directoryKey,
        backend: "codex" as const,
        executionMode: "default" as const,
        workMode: "local" as const,
        prompt: "",
        prAutoDispatchEnabled: request.patch.prAutoDispatchEnabled,
        createdAt: 1,
        updatedAt: 2,
      },
      defaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    }));
    const setEligibleThreadsPrAutoDispatch = vi.fn(async (request) => ({
      enabled: request.enabled,
      eligibleThreadCount: 3,
      updatedThreadCount: request.dryRun ? 2 : 2,
    }));
    const desktopApi = {
      getNavigationSnapshot,
      updateDirectoryLaunchpad,
      setEligibleThreadsPrAutoDispatch,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="git"
        settings={settings}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Apply to launchpads" }));
    expect(await screen.findByText("Apply to 2 launchpads?")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(updateDirectoryLaunchpad).toHaveBeenCalledTimes(2);
    });
    expect(updateDirectoryLaunchpad).toHaveBeenNthCalledWith(1, {
      directoryKey: "directory:/repo-a",
      patch: { prAutoDispatchEnabled: true },
      stickySettingsChanged: true,
    });
    expect(updateDirectoryLaunchpad).toHaveBeenNthCalledWith(2, {
      directoryKey: "directory:/repo-b",
      patch: { prAutoDispatchEnabled: true },
      stickySettingsChanged: true,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Enable existing PR threads…" }),
    );
    await waitFor(() => {
      expect(setEligibleThreadsPrAutoDispatch).toHaveBeenCalledWith({
        enabled: true,
        dryRun: true,
      });
    });
    expect(
      await screen.findByText("Enable Auto-fix PR for 2 existing threads?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => {
      expect(setEligibleThreadsPrAutoDispatch).toHaveBeenLastCalledWith({
        enabled: true,
      });
    });
    expect(
      screen.getByText(
        "Enabled Auto-fix PR for 2 existing threads with a primary attached pull request.",
      ),
    ).toBeInTheDocument();
  });

  it("pins both axes from one tile click, and reports each slot's own version", async () => {
    const settings = createSettingsState(
      createSnapshot({
        updates: {
          channel: { value: "prerelease", source: "default" },
          train: { value: "beta", source: "default" },
          selectionSource: "inferred",
        },
      }),
    );
    const desktopApi = {
      readAppUpdateReleaseVersions: vi.fn(async () => ({
        fetchedAt: 1,
        stable: {
          latest: { version: "v1.0.1" },
          prerelease: { version: "v1.0.1" },
        },
        beta: {
          latest: { version: "v1.1.0-beta.2" },
          prerelease: { version: "v1.1.0-alpha.7" },
        },
      })),
    };

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        onClose={() => undefined}
      />,
    );

    // Every slot states its own version. The two-control shape could not:
    // with the track control on Prerelease, the Stable button labelled
    // itself from `stable.latest` and the track buttons from the selected
    // train, so no reading of the pane showed all four at once.
    expect(
      await screen.findByRole("radio", { name: "Beta Prerelease — v1.1.0-alpha.7" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      screen.getByRole("radio", { name: "Beta Latest — v1.1.0-beta.2" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Stable Latest — v1.0.1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Stable Prerelease — v1.0.1" }),
    ).toBeInTheDocument();

    // While the selection is inferred the pane says so; a click pins it and
    // main derives `selection_source` from the patch naming both axes.
    expect(
      screen.getByText("Following the build you installed. Pick a slot to pin it."),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("radio", { name: "Beta Latest — v1.1.0-beta.2" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        updates: {
          channel: "latest",
          train: "beta",
        },
      });
    });
  });

  it("blocks settings edits when the config file cannot be parsed", () => {
    render(
      <SettingsScreen
        settings={createSettingsState(
          createSnapshot({
            configError: "line 3: expected a key",
            configPath: "/tmp/pwragent/config.toml",
          }),
        )}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Settings config did not load");
    expect(screen.getByRole("alert")).toHaveTextContent("line 3: expected a key");
    expect(screen.getByRole("alert")).toHaveTextContent("/tmp/pwragent/config.toml");
    expect(screen.queryByRole("radio", { name: "TipTap with chips" })).not.toBeInTheDocument();
  });
});
