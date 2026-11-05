import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../lib/desktop-api";
import { App } from "../App";

// What this pins is File → Thread Maintenance… opening the dialog, with the
// project a push names. The dialog has its own tests.
vi.mock("../features/maintenance/ThreadMaintenanceDialog", () => ({
  ThreadMaintenanceDialog: (props: { projectKey?: string }) => (
    <div data-testid="thread-maintenance-dialog" data-project={props.projectKey ?? ""} />
  ),
}));

afterEach(() => {
  cleanup();
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

function installDesktopApi(): { push: (request: { projectKey?: string }) => Promise<void> } {
  let listener: ((request: { projectKey?: string }) => void) | undefined;
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
              calmMotion: { value: false, source: "default" },
              density: { value: "mission-control", source: "default" },
              sidebarTextSize: { value: "md", source: "default" },
              transcriptTextSize: { value: "md", source: "default" },
            },
          },
          onboarding: { completed: { value: true, source: "default" } },
          imageUploads: { pastedImageMaxPatches: { value: 1536, source: "default" } },
          experimental: { fullAccessRiskWarningDismissed: { value: false, source: "default" } },
        } as DesktopSettingsSnapshot,
      }),
      onAgentEvent: () => () => undefined,
      scanThreadMaintenance: vi.fn(),
      onOpenThreadMaintenanceRequested: (next: (request: { projectKey?: string }) => void) => {
        listener = next;
        return () => { listener = undefined; };
      },
    } as Partial<DesktopApi>,
  });
  return {
    push: async (request) => {
      await waitFor(() => expect(listener).toBeDefined());
      await act(async () => {
        listener?.(request);
        await Promise.resolve();
      });
    },
  };
}

describe("File → Thread Maintenance…", () => {
  it("opens the dialog in the main window", async () => {
    const api = installDesktopApi();
    render(<App />);
    expect(screen.queryByTestId("thread-maintenance-dialog")).toBeNull();

    await api.push({});

    expect(await screen.findByTestId("thread-maintenance-dialog")).toBeInTheDocument();
  });

  it("passes on the project a push names", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push({ projectKey: "/src/harbor-web" });

    expect(await screen.findByTestId("thread-maintenance-dialog")).toHaveAttribute("data-project", "/src/harbor-web");
  });
});
