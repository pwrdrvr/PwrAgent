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
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
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
      enabled: { value: true, source: "default" },
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
      attachments: {
        imageProfile: { value: "medium", source: "default" },
        maxAttachmentBytes: { value: 10485760, source: "default" },
        maxAttachmentCount: { value: 4, source: "default" },
      },
    },
    models: {
      codex: {
        path: { value: "", source: "default" },
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
      },
      grok: {
        apiKey: { configured: false, source: "unset", writable: true },
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

describe("SettingsScreen", () => {
  it("switches sections and saves settings", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    expect(within(sections).getByRole("button", { name: "Applications" })).toHaveAttribute(
      "aria-current",
      "page",
    );

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

    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
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
    expect(screen.getAllByText(/does not make turns finish sooner/)).toHaveLength(4);
    expect(screen.getAllByText(/reach platform rate limits much sooner/)).toHaveLength(4);
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
    // chip instead). With the seed data the selected candidate is
    // `/usr/local/bin/codex`, so the single "Use" here points at
    // `/Applications/Codex.app/Contents/Resources/codex`.
    const useButtons = screen.getAllByRole("button", { name: "Use" });
    expect(useButtons).toHaveLength(1);
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

    fireEvent.click(within(sections).getByRole("button", { name: "Applications" }));
    expect(within(sections).getByRole("button", { name: "Experimental" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
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

  it("renders the Mattermost section and saves edits via writeConfig", async () => {
    const settings = createSettingsState();
    render(<SettingsScreen settings={settings} onClose={() => undefined} />);

    const sections = screen.getByRole("navigation", { name: "Settings sections" });
    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));

    expect(
      screen.getByRole("heading", { name: "Mattermost" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Server URL")).toBeInTheDocument();
    expect(screen.getByText("Callback Base URL")).toBeInTheDocument();
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
        name: "Replace",
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
    fireEvent.click(screen.getAllByRole("button", { name: "Replace" })[0]);

    await waitFor(() => {
      expect(settings.replaceSecret).toHaveBeenCalledWith(
        "telegramBotToken",
        "123456789:secret-token",
      );
    });
    expect(tokenInput).toHaveValue("123456789:secret-token");
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
