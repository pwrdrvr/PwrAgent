import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../lib/desktop-api";
import type { WindowOpenMainViewRequest } from "../../../shared/ipc";
import { App } from "../App";

// Both screens need far more of the desktop API than this file stubs. What it
// pins is the mapping from View → Search Threads / View → Automations to the
// screen App shows.
vi.mock("../features/thread-search/ThreadSearchPanel", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../features/thread-search/ThreadSearchPanel")
  >()),
  ThreadSearchPanel: () => <div data-testid="thread-search-screen" />,
}));
vi.mock("../features/automations/AutomationsScreen", () => ({
  AutomationsScreen: () => <div data-testid="automations-screen" />,
}));

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

function installDesktopApi(): {
  push: (view: WindowOpenMainViewRequest) => Promise<void>;
} {
  let listener: ((view: WindowOpenMainViewRequest) => void) | undefined;
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      readSettings: async () => ({
        snapshot: {
          general: {
            appearance: {
              theme: { value: "system", source: "default" },
              darkTheme: { value: "tangerine-dark", source: "default" },
              lightTheme: { value: "tangerine-light", source: "default" },
              themedDockIcon: { value: true, source: "default" },
              terminalMinimumContrast: { value: false, source: "default" },
              density: { value: "mission-control", source: "default" },
              sidebarTextSize: { value: "md", source: "default" },
              transcriptTextSize: { value: "md", source: "default" },
            },
          },
          onboarding: {
            completed: { value: true, source: "default" },
          },
          imageUploads: {
            pastedImageMaxPatches: { value: 1536, source: "default" },
          },
          experimental: {
            fullAccessRiskWarningDismissed: {
              value: false,
              source: "default",
            },
          },
        } as DesktopSettingsSnapshot,
      }),
      onAgentEvent: () => () => undefined,
      onOpenMainViewRequested: (
        next: (view: WindowOpenMainViewRequest) => void,
      ) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as Partial<DesktopApi>,
  });
  return {
    push: async (view) => {
      await waitFor(() => expect(listener).toBeDefined());
      await act(async () => {
        listener?.(view);
        await Promise.resolve();
      });
    },
  };
}

describe("menu pushes into the main view", () => {
  it("opens Automations for View → Automations", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push("automations");

    expect(await screen.findByTestId("automations-screen")).toBeInTheDocument();
  });

  it("opens Search for View → Search Threads, and keeps it open on a second pick", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push("search");
    expect(await screen.findByTestId("thread-search-screen")).toBeInTheDocument();

    // The masthead button and ⇧⌘F toggle; the menu row names a screen.
    await api.push("search");
    expect(screen.getByTestId("thread-search-screen")).toBeInTheDocument();
  });
});
