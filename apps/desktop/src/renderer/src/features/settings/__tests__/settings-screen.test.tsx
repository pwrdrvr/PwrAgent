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
    clearSecret: vi.fn(async () => undefined),
    composerImplementation: snapshot.experimental.chatReplyComposer.value,
    loading: false,
    refresh: vi.fn(async () => undefined),
    replaceSecret: vi.fn(async () => undefined),
    saving: false,
    snapshot,
    writeConfig: vi.fn(async () => undefined),
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

    fireEvent.click(within(sections).getByRole("button", { name: "Models" }));
    expect(screen.getByRole("heading", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByText("/usr/local/bin/codex")).toBeInTheDocument();
  });

  it("returns to the previous app surface", () => {
    const onClose = vi.fn();
    render(<SettingsScreen settings={createSettingsState()} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
