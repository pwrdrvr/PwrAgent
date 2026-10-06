import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopSettingsSnapshot } from "@pwragent/shared";
import type { DesktopApi } from "../lib/desktop-api";
import { App } from "../App";

type SettingsProps = {
  initialSection?: string;
  initialSubsection?: string;
  profileCreateRequested?: boolean;
  onProfileCreateRequestHandled?: () => void;
};

const settingsProps: SettingsProps[] = [];

// The real screen needs a full settings snapshot. What this file pins is the
// mapping from the main-process push to the props App hands Settings.
vi.mock("../features/settings/SettingsScreen", () => ({
  SettingsScreen: (props: SettingsProps) => {
    settingsProps.push(props);
    return (
      <div data-testid="settings-screen">
        {props.initialSection ?? "general"}
        {props.profileCreateRequested ? " create" : ""}
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  settingsProps.length = 0;
  delete (window as Window & { pwragent?: DesktopApi }).pwragent;
});

function installDesktopApi(): {
  push: (section?: string, subsection?: string) => Promise<void>;
} {
  let listener: ((section?: string, subsection?: string) => void) | undefined;
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
      onOpenSettingsRequested: (
        next: (section?: string, subsection?: string) => void,
      ) => {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as Partial<DesktopApi>,
  });
  return {
    push: async (section, subsection) => {
      await waitFor(() => expect(listener).toBeDefined());
      await act(async () => {
        listener?.(section, subsection);
        await Promise.resolve();
      });
    },
  };
}

describe("menu pushes into Settings", () => {
  it("opens Settings → About for About PwrAgent", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push("about");

    expect(await screen.findByTestId("settings-screen")).toHaveTextContent(
      "about",
    );
  });

  it("opens Profiles with the create form for New Profile…, on every click", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push("profiles", "new");
    expect(await screen.findByTestId("settings-screen")).toHaveTextContent(
      "profiles create",
    );
    // A "new" route would stick to the pane; the request is a one-shot flag.
    expect(settingsProps.at(-1)?.initialSubsection).toBeUndefined();

    // The pane reports the form open, which clears the request.
    await act(async () => {
      settingsProps.at(-1)?.onProfileCreateRequestHandled?.();
      await Promise.resolve();
    });
    expect(screen.getByTestId("settings-screen")).toHaveTextContent(/^profiles$/);

    await api.push("profiles", "new");
    expect(screen.getByTestId("settings-screen")).toHaveTextContent(
      "profiles create",
    );
  });

  it("opens Profiles on the list for Manage Profiles…", async () => {
    const api = installDesktopApi();
    render(<App />);

    await api.push("profiles");

    expect(await screen.findByTestId("settings-screen")).toHaveTextContent(
      /^profiles$/,
    );
  });
});
