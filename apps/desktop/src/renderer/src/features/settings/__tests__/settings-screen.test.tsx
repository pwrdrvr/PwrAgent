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
    fireEvent.click(screen.getAllByRole("checkbox", { name: "Streaming Responses" })[0]!);
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        messaging: {
          telegram: {
            authorizedSupergroups: [],
            authorizedUserIds: [],
            enabled: false,
            streamingResponses: true,
          },
        },
      });
    });
    expect(screen.getAllByText("unset").length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(2);

    fireEvent.click(within(sections).getByRole("button", { name: "Models" }));
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/codex")).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Auto Discovery - Use Newest" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("0.130.0")).toBeInTheDocument();
    expect(screen.getByText("Using /usr/local/bin/codex")).toBeInTheDocument();

    const useButtons = screen.getAllByRole("button", { name: "Use" });
    fireEvent.click(useButtons[1]);
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

  it("returns to the previous app surface", () => {
    const onClose = vi.fn();
    render(<SettingsScreen settings={createSettingsState()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onClose).toHaveBeenCalledOnce();
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
