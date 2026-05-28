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
  AppServerListThreadsResponse,
  AppServerThreadSummary,
  DesktopSettingsSnapshot,
  MessagingPairingEntry,
  WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { SettingsScreen } from "../SettingsScreen";
import type { DesktopSettingsState } from "../useDesktopSettings";

afterEach(() => {
  cleanup();
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
      developerMode: {
        value: false,
        source: "default",
      },
      appearance: {
        theme: { value: "system", source: "default" },
        density: { value: "mission-control", source: "default" },
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
      diffCondensation: {
        enabled: { value: false, source: "default" },
        model: { value: "auto", source: "default" },
      },
      agentCoreGrok: { value: false, source: "default" },
    },
    imageUploads: {
      pastedImageMaxPatches: { value: 1536, source: "default" },
    },
    updates: {
      channel: { value: "latest", source: "default" },
    },
    messaging: {
      enabled: { value: true, source: "default" },
      allowFullAccessEscalation: { value: true, source: "default" },
      allowFullAccessThreadResume: { value: true, source: "default" },
      fullAccessWarning: { value: "dismissable", source: "default" },
      inputDebounceMs: { value: 500, source: "default" },
      toolUpdateMode: { value: "show_some", source: "default" },
      telegram: {
        enabled: { value: false, source: "default" },
        streamingResponses: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        authorizedUserIds: { value: [], source: "default" },
        authorizedSupergroups: { value: [], source: "default" },
      },
      discord: {
        enabled: { value: false, source: "default" },
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
        streamingResponses: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        appToken: { configured: false, source: "unset", writable: true },
        signingSecret: { configured: false, source: "unset", writable: true },
        workspaceUrl: { value: "", source: "default" },
        inboundMode: { value: "socket", source: "default" },
        slashCommandPrefix: { value: "pwragent_", source: "default" },
        registerSlashCommands: { value: false, source: "default" },
        authorizedUserIds: { value: [], source: "default" },
        authorizedWorkspaces: { value: [], source: "default" },
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
      grok: {
        apiKey: { configured: false, source: "unset", writable: true },
      },
    },
    acpAgents: {
      grok: { cliPath: { value: "", source: "default" } },
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
  it("switches sections and saves settings", async () => {
    const settings = createSettingsState();
    const desktopApi = {
      readAppUpdateReleaseVersions: vi.fn(async () => ({
        fetchedAt: 1,
        latest: { version: "v1.0.0" },
        prerelease: { version: "v1.0.0-beta.7" },
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
    expect(screen.getByRole("radio", { name: /Latest/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Developer Mode" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(screen.getByRole("switch", { name: "Developer Mode" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        general: {
          developerMode: true,
        },
      });
    });

    expect(await screen.findByText("v1.0.0-beta.7")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /Prerelease/ }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        updates: {
          channel: "prerelease",
        },
      });
    });

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

    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        applications: {
          terminal: {
            preferredId: "ghostty",
          },
        },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Experimental" }));
    expect(screen.queryByRole("radiogroup", { name: "Chat Reply Composer" })).not.toBeInTheDocument();
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

    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Medium" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "High" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          attachments: {
            imageProfile: "high",
          },
        },
      });
    });
    expect(screen.getByRole("radio", { name: "Show Some" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "Show All" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          toolUpdateMode: "show_all",
        },
      });
    });
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
    expect(screen.getByRole("heading", { name: "Telegram" })).toBeInTheDocument();
    expect(screen.getByText("Authorized Groups / Supergroups")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Group/supergroup chat" }),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/does not make turns finish sooner/)).toHaveLength(6);
    expect(screen.getAllByText(/reach platform rate limits much sooner/)).toHaveLength(6);
    fireEvent.click(
      screen.getAllByRole("switch", { name: "Streaming Responses (Advanced)" })[0]!,
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
    expect(screen.getAllByText("unset").length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(sections).getByRole("button", { name: "Models" }));
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    // The selected command appears in two places now: the pathrow
    // list (Codex discovery candidates) AND the SettingsTestBlock's
    // default name (it shows the path the Test button would invoke).
    // Both are correct.
    expect(screen.getAllByText("/usr/local/bin/codex").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("radio", { name: "Auto Discovery - Use Newest" }),
    ).toHaveAttribute("aria-checked", "true");
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

  it("defaults live transcript event filtering off for stale snapshots", async () => {
    const snapshot = createSnapshot() as any;
    delete snapshot.experimental.liveTranscriptEventFiltering;
    const settings = createSettingsState(snapshot);

    render(
      <SettingsScreen
        initialSection="experimental"
        settings={settings}
      />,
    );

    const filteringSwitch = screen.getByRole("switch", {
      name: "Enable live transcript event filtering",
    });
    expect(filteringSwitch).toHaveAttribute("aria-checked", "false");

    fireEvent.click(filteringSwitch);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { liveTranscriptEventFiltering: true },
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
              id: "/Users/huntharo/.codex/worktrees/mp7efuda/PwrSnap",
              label: "PwrSnap",
              path: "/Users/huntharo/.codex/worktrees/mp7efuda/PwrSnap",
              worktreePath:
                "/Users/huntharo/.codex/worktrees/mp7efuda/PwrSnap",
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
              id: "/Users/huntharo/.codex/worktrees/mp32wplq/PwrSnap",
              label: "PwrSnap",
              path: "/Users/huntharo/.codex/worktrees/mp32wplq/PwrSnap",
              worktreePath:
                "/Users/huntharo/.codex/worktrees/mp32wplq/PwrSnap",
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
    const activeWorkspaceRoot = "/Users/huntharo/.pwragent/profiles/dev/projects";
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
              id: "/Users/huntharo/.pwragnt/projects",
              label: "projects",
              path: "/Users/huntharo/.pwragnt/projects",
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

  it("opens the ACP Agents settings section", async () => {
    const desktopApi = {
      listAcpAgents: vi.fn(async () => ({
        fetchedAt: 1000,
        entries: [],
      })),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        initialSection="agents"
        settings={createSettingsState()}
      />,
    );

    expect(await screen.findByRole("heading", { name: "ACP Agents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "ACP Agents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
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
      account: "huntharo",
      scopes: ["repo"],
      hasRepoScope: true,
      discovery: snapshot.applications.gh.discovery,
    }));

    render(
      <SettingsScreen
        desktopApi={{ getGhStatus }}
        initialSection="applications"
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

    fireEvent.click(within(ghPanel).getByRole("button", { name: "Use" }));
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

  it("shows Git discovery and Xcode license remediation", async () => {
    const snapshot = createSnapshot();
    snapshot.applications.git = {
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
        initialSection="applications"
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

  it("renders the Mattermost section and saves edits via writeConfig", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));

    expect(
      screen.getByRole("heading", { name: "Mattermost" }),
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
    expect(screen.getByText(/Rejected Telegram DMs show the peer ID/)).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!);
    const telegramUserIds = screen.getByLabelText("Authorized User IDs ID 1");
    fireEvent.change(telegramUserIds, { target: { value: "@huntharo" } });
    fireEvent.blur(telegramUserIds);

    expect(
      await screen.findByText(/That looks like a Telegram username/),
    ).toBeInTheDocument();
    expect(telegramUserIds).toHaveAttribute("aria-invalid", "true");
    expect(settings.writeConfig).not.toHaveBeenCalledWith({
      messaging: {
        telegram: {
          authorizedUserIds: [{ id: "@huntharo", displayName: "" }],
        },
      },
    });

    fireEvent.change(telegramUserIds, { target: { value: "8460800771" } });
    fireEvent.change(
      screen.getByLabelText("Authorized User IDs display name 1"),
      { target: { value: "Harold (@huntharo)" } },
    );
    fireEvent.blur(telegramUserIds);

    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedUserIds: [
              { id: "8460800771", displayName: "Harold (@huntharo)" },
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
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText(/Required before going online/)).toHaveLength(2);
    expect(screen.getByText(/go online in Lark Developer/)).toBeInTheDocument();
    expect(screen.getByText(/Feishu is China only/)).toBeInTheDocument();
    expect(screen.getByLabelText("Tenant URL")).toHaveValue("");
    expect(screen.getByText(/Leave blank to use/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("Local Webhook Listener")).toHaveLength(1);
    expect(screen.getByLabelText("Local Webhook Listener")).toHaveAttribute(
      "placeholder",
      "http://127.0.0.1:47822",
    );
  });

  it("shows the Feishu local webhook listener only for webhook mode", () => {
    const snapshot = createSnapshot();
    snapshot.messaging.feishu.inboundMode = { value: "webhook", source: "config" };

    render(
      <SettingsScreen
        settings={createSettingsState(snapshot)}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    const feishuLocalWebhook = screen
      .getAllByLabelText("Local Webhook Listener")
      .find((input) => !input.hasAttribute("placeholder"));
    expect(feishuLocalWebhook).toHaveValue("");
    expect(screen.getByText(/Default:/)).toHaveTextContent("http://127.0.0.1:47823");
    expect(screen.getByText(/Only used when Webhook is selected/)).toBeInTheDocument();
  });

  it("looks up blank messaging display names from the settings screen", async () => {
    const settings = createSettingsState();
    const resolveMessagingContact = vi.fn(async () => ({
      status: "ok" as const,
      id: "8460800771",
      displayName: "Harold (@huntharo)",
      handle: "@huntharo",
    }));
    const desktopApi = {
      resolveMessagingContact,
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
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
              { id: "8460800771", displayName: "Harold (@huntharo)" },
            ],
          },
        },
      });
    });
    expect(
      screen.getByLabelText("Authorized User IDs display name 1"),
    ).toHaveValue("Harold (@huntharo)");
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
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Generate" })[0]!);
    expect(await screen.findByText(pairingMessage)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(bridgeCopy).toHaveBeenCalledWith(pairingMessage);
    });
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(pairingMessage);
    });
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
    let pairingChanged:
      | ((event: { at: number; entry: MessagingPairingEntry }) => void)
      | undefined;
    const desktopApi = {
      generateMessagingPairingToken: vi.fn(async () => ({
        entry,
        expiresAt: 2,
        message: pairingMessage,
        token: "123456789ABCDEFGHJKLMNPQRSTUVWXY",
      })),
      listMessagingPairingRequests: vi.fn(async () => ({ entries: [] })),
      onMessagingPairingChanged: vi.fn((callback) => {
        pairingChanged = callback;
        return () => undefined;
      }),
    } as unknown as Parameters<typeof SettingsScreen>[0]["desktopApi"];

    render(
      <SettingsScreen
        desktopApi={desktopApi}
        settings={settings}
        initialSection="messaging"
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Generate" })[0]!);
    expect(await screen.findByText(pairingMessage)).toBeInTheDocument();

    act(() => {
      pairingChanged?.({
        at: 3,
        entry: {
          ...entry,
          status: "observed",
          observedAt: 3,
          observedActor: { id: "8460800771", displayName: "Harold Hunt" },
          observedChat: { id: "8460800771", kind: "dm", title: "Harold Hunt" },
        },
      });
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

  it("shows observed pairing IDs and refreshes authorized IDs after approval", async () => {
    const snapshot = createSnapshot();
    const initialSnapshot: DesktopSettingsSnapshot = {
      ...snapshot,
      messaging: {
        ...snapshot.messaging,
        telegram: {
          ...snapshot.messaging.telegram,
          enabled: { value: true, source: "config" },
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
        username: "huntharo",
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
        added: true,
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
          onClose={() => undefined}
        />
      );
    }

    render(<Harness />);

    const request = await screen.findByText("Harold Hunt wants access");
    const requestCard = request.closest(".settings-pairing__request");
    expect(requestCard).not.toBeNull();
    expect(requestCard).toHaveTextContent("User ID 8460800771");
    expect(requestCard).toHaveTextContent("@huntharo");
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
        platform: "slack",
        kind: "user",
        id: "U079K80HTGS",
      });
    });
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          slack: {
            authorizedUserIds: [{ id: "U079K80HTGS", displayName: "Harold Hunt" }],
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
        onClose={() => undefined}
      />,
    );

    const signingSecretInput = screen.getByLabelText("Signing Secret");
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
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("radio", { name: "Socket Mode" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Events API" })).not.toBeInTheDocument();
  });

  it("sanitizes manually entered messaging display names before saving", async () => {
    const settings = createSettingsState();

    render(
      <SettingsScreen
        settings={settings}
        initialSection="messaging"
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
        displayName: "Harold (@huntharo)",
      });
    });

    expect(writeConfig).toHaveBeenCalledTimes(callsBeforeLookupResolution);
    expect(writeConfig).not.toHaveBeenCalledWith({
      messaging: {
        telegram: {
          authorizedUserIds: [
            { id: "8460800771", displayName: "Harold (@huntharo)" },
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
              { id: "@huntharo", displayName: "Wrong person" },
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
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("@huntharo")).toBeInTheDocument();
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
      { target: { value: "work" } },
    );
    fireEvent.click(within(createDialog).getByRole("button", { name: "Add profile" }));
    await waitFor(() => {
      expect(createPwrAgentProfile).toHaveBeenCalledWith({ profile: "work" });
    });

    expect(await screen.findByText("scratch")).toBeInTheDocument();
    expect(screen.getByText("/home/example/.pwragent/profiles/dev")).toBeInTheDocument();

    const scratchRow = screen
      .getByText("scratch")
      .closest(".settings-profile-row") as HTMLElement;
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

    const workRow = screen
      .getByText("/home/example/.pwragent/profiles/work")
      .closest(".settings-profile-row") as HTMLElement;
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

  it("fires onOpenMessagingActivity when a title-bar platform chip is clicked", async () => {
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

    await waitFor(() => {
      expect(onOpenMessagingActivity).toHaveBeenCalled();
    });
    // The breadcrumb stays on whatever section was active — chip
    // clicks no longer mutate the section selection.
    const current = document.querySelector(".settings-titlebar__current");
    expect(current?.textContent).not.toBe("Messaging activity");
  });

  it("places Exit Settings as the first row of the settings nav (NOT in the title bar)", () => {
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
  });

  it("renders a 'General' group label between Exit Settings and the section list", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const label = document.querySelector(".settings-nav__group-label");
    expect(label).not.toBeNull();
    expect(label?.textContent?.toLowerCase()).toBe("general");
  });

  it("orders settings nav sections with worktree settings separated", () => {
    render(
      <SettingsScreen
        settings={createSettingsState()}
        onClose={() => undefined}
      />,
    );

    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const buttons = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(buttons).toEqual([
      "← Exit Settings",
      "General",
      "Applications",
      "Profiles",
      "Models",
      "ACP Agents",
      "Messaging",
      "Worktrees",
      "Archived Threads",
      "Experimental",
      "About",
    ]);
    expect(within(nav).getByRole("separator")).toHaveClass(
      "settings-nav__divider",
    );
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

    fireEvent.click(screen.getByRole("radio", { name: "Always" }));
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
    const tokenInput = screen.getAllByLabelText("Bot Token")[0];
    fireEvent.change(tokenInput, {
      target: { value: "123456789:secret-token" },
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Discard" })[0]);

    expect(tokenInput).toHaveValue("");
    expect(settings.replaceSecret).not.toHaveBeenCalled();
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
