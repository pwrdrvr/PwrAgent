import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { AppTitleBar } from "../AppTitleBar";
import { ThreadHeader } from "../../thread-detail/ThreadHeader";
import { ThreadPlaceholderHeader } from "../../thread-detail/ThreadPlaceholderHeader";

/**
 * The Windows title strip and the view header are mounted at the same time, so
 * a control drawn by both appears twice on screen. That is not hypothetical:
 * the strip and `ThreadHeader` each drew a Star Map button, and Windows shipped
 * with two of them side by side while the breadcrumb sat alone on the row
 * below, level with the sidebar's identity pills instead of with the chrome.
 *
 * The rule these tests pin: the strip carries OS chrome (wordmark, menu, app
 * actions, the one Messaging controller); the view header carries view chrome
 * (history, breadcrumb, chips, panel toggles, terminal, Star Map). Nothing is
 * in both, and the view header renders the same controls on every platform.
 *
 * Counting queries are `getAllBy*` on purpose — `getBy*` throws on a duplicate,
 * which reads as "broken test" rather than "two buttons shipped".
 *
 * Which of these actually caught the shipped bug, checked by running the file
 * against the pre-fix components: the two placement tests below ("keeps the
 * Windows title strip free of view chrome" and the win32 row of the
 * same-cluster table) fail there. The two counting tests do NOT — the strip
 * drew its Star Map from a `starMap` prop that no longer exists, so they
 * cannot reproduce the old wiring. They stay because they count what is on
 * screen rather than what a component was handed, which is the check that
 * survives someone adding a Star Map back to the strip by some other route.
 */

const noop = () => {};

const thread = {
  id: "thread-1",
  title: "Add Windows Codex Environment docs",
  source: "codex",
  inbox: "inbox",
  createdAt: 0,
  updatedAt: 0,
} as unknown as NavigationThreadSummary;

const threadLayout = {
  sidebarOpen: true,
  railOpen: false,
  terminalOpen: false,
  onToggleSidebar: noop,
  onToggleRail: noop,
  onToggleTerminal: noop,
};

const titleBarActions = {
  automationsActive: false,
  settingsActive: false,
  creatingThread: false,
  onOpenAutomations: noop,
  onOpenSettings: noop,
  onCreateThread: noop,
};

function setPlatform(platform: string): void {
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: { platform },
  });
}

beforeEach(() => {
  // MessagingStatusBar polls on mount; a bare stub keeps it quiet.
  vi.stubGlobal("matchMedia", window.matchMedia);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

describe("Windows chrome placement", () => {
  it("draws exactly one Star Map button with the strip and thread header both mounted", () => {
    setPlatform("win32");
    render(
      <>
        <AppTitleBar
          layout={{ sidebarOpen: true }}
          actions={titleBarActions}
        />
        <ThreadHeader
          thread={thread}
          layout={threadLayout}
          starMap={{ onOpen: noop }}
        />
      </>,
    );

    expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
  });

  it("draws exactly one Star Map button with the strip and placeholder header both mounted", () => {
    setPlatform("win32");
    render(
      <>
        <AppTitleBar
          layout={{ sidebarOpen: true }}
          actions={titleBarActions}
        />
        <ThreadPlaceholderHeader
          title="Loading..."
          layout={{ sidebarOpen: true, railOpen: false, onToggleSidebar: noop, onToggleRail: noop }}
          starMap={{ onOpen: noop }}
        />
      </>,
    );

    expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
  });

  it("keeps the Windows title strip free of view chrome", () => {
    setPlatform("win32");
    render(
      <AppTitleBar layout={{ sidebarOpen: true }} actions={titleBarActions} />,
    );

    // The strip's own controls are still there...
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    // ...and nothing that belongs to the view header is.
    expect(screen.queryByRole("button", { name: "Open Star Map" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Window layout" })).toBeNull();
  });

  it.each(["win32", "darwin", "linux"])(
    "gives the %s thread header the same view-chrome cluster",
    (platform) => {
      setPlatform(platform);
      render(
        <ThreadHeader
          thread={thread}
          layout={threadLayout}
          starMap={{ onOpen: noop }}
        />,
      );

      expect(screen.getByRole("group", { name: "Window layout" })).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Open integrated terminal" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open Star Map" })).toBeInTheDocument();
    },
  );
});
