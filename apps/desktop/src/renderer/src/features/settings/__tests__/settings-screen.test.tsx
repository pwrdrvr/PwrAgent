import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragnt/shared";
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
    configPath: "/tmp/pwragnt/config.toml",
    secretStorage: {
      available: true,
      backend: "memory",
      encrypted: false,
    },
    experimental: {
      chatReplyComposer: {
        value: "textarea",
        source: "default",
      },
    },
    messaging: {
      telegram: {
        enabled: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
        authorizedUserIds: { value: [], source: "default" },
        authorizedSupergroups: { value: [], source: "default" },
      },
      discord: {
        enabled: { value: false, source: "default" },
        botToken: { configured: false, source: "unset", writable: true },
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
    expect(within(sections).getByRole("button", { name: "Experimental" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    fireEvent.click(screen.getByRole("radio", { name: "TipTap with chips" }));
    await waitFor(() => {
      expect(settings.writeConfig).toHaveBeenCalledWith({
        experimental: { chatReplyComposer: "tiptap-chips" },
      });
    });

    fireEvent.click(within(sections).getByRole("button", { name: "Messaging" }));
    expect(screen.getByRole("heading", { name: "Telegram" })).toBeInTheDocument();
    expect(screen.getByText("Authorized SuperGroups")).toBeInTheDocument();
    expect(screen.getAllByText("unset").length).toBeGreaterThanOrEqual(5);
    expect(screen.getAllByText("default").length).toBeGreaterThanOrEqual(3);

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
  });

  it("returns to the previous app surface", () => {
    const onClose = vi.fn();
    render(<SettingsScreen settings={createSettingsState()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onClose).toHaveBeenCalledOnce();
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
            configPath: "/tmp/pwragnt/config.toml",
          }),
        )}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Settings config did not load");
    expect(screen.getByRole("alert")).toHaveTextContent("line 3: expected a key");
    expect(screen.getByRole("alert")).toHaveTextContent("/tmp/pwragnt/config.toml");
    expect(screen.queryByRole("radio", { name: "TipTap with chips" })).not.toBeInTheDocument();
  });
});
