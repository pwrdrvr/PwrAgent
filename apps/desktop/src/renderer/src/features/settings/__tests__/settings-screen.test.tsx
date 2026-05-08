import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import { SettingsScreen } from "../SettingsScreen";
import type { DesktopSettingsState } from "../useDesktopSettings";

afterEach(() => {
  cleanup();
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
  it("switches sections and saves the composer preference", async () => {
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
    fireEvent.click(screen.getByRole("radio", { name: "TipTap raw Markdown + chips" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { chatReplyComposer: "tiptap-chips" },
      });
    });

    fireEvent.click(
      screen.getByRole("radio", { name: "TipTap WYSIWYG Markdown + chips" }),
    );
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { chatReplyComposer: "tiptap-wysiwyg-markdown-chips" },
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
    expect(screen.getByText("Authorized SuperGroups")).toBeInTheDocument();
    expect(screen.getAllByText(/Voice readers may speak each partial edit/)).toHaveLength(3);
    expect(screen.getAllByText(/quickly hit platform rate limits/)).toHaveLength(3);
    fireEvent.click(screen.getAllByRole("switch", { name: "Streaming Responses" })[0]!);
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
    expect(screen.getByText("Register slash commands")).toBeInTheDocument();
    // The slash command prefix field should be disabled while
    // registerSlashCommands is off.
    const prefixInput = screen.getByLabelText("Slash command prefix");
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
      screen.getByRole("switch", { name: "Register slash commands" }),
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
          platform: "telegram" as const,
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
      "--disable-messaging was provided at startup",
    );
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
