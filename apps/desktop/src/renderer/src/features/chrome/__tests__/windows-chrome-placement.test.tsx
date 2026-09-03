import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { AppTitleBar } from "../AppTitleBar";
import { ThreadHeader } from "../../thread-detail/ThreadHeader";
import { ThreadPlaceholderHeader } from "../../thread-detail/ThreadPlaceholderHeader";

/**
 * The Windows title strip and the view header are mounted at the same time, so
 * a control drawn by both appears twice on screen. That is not hypothetical:
 * both rendered a Star Map button and Windows shipped with two of them.
 *
 * The rule these tests pin — window chrome lives in ONE place per platform:
 *
 *   win32   strip:  wordmark, menu, app actions, panel toggles, Star Map, MSG
 *           header: history, breadcrumb, chips, terminal
 *   others  strip:  not rendered at all
 *           header: all of it
 *
 * The terminal toggle is the one control in the cluster that stays in the
 * header everywhere, because its state is per-thread (running dot, per-thread
 * disabled reason); putting it in a global strip would drag thread state up
 * into it.
 *
 * Checked against the pre-fix components, three of these fail: both Star Map
 * counting cases and the win32 ownership case, all because the header drew an
 * unguarded Star Map beside the strip's. The other four pass there — the panel
 * toggles were already strip-owned on win32, and the terminal and the
 * off-win32 behavior are unchanged by that fix. They are here to hold those
 * halves of the rule in place, not because they caught anything.
 *
 * Counting queries are `getAllBy*` on purpose: `getBy*` throws on a duplicate,
 * which reads as "broken test" rather than "two buttons shipped".
 */

const noop = () => {};

const thread = {
  id: "thread-1",
  title: "Tighten the settings panel spacing",
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

const placeholderLayout = {
  sidebarOpen: true,
  railOpen: false,
  onToggleSidebar: noop,
  onToggleRail: noop,
};

const titleBarLayout = { ...placeholderLayout };

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

afterEach(() => {
  cleanup();
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: undefined,
  });
});

describe("Windows chrome placement", () => {
  // Both surfaces get every control prop, the way App wires them — the point
  // is that the components, not the caller, decide which one draws what.
  const bothMounted = (
    <>
      <AppTitleBar
        layout={titleBarLayout}
        starMap={{ onOpen: noop }}
        actions={titleBarActions}
      />
      <ThreadHeader
        thread={thread}
        layout={threadLayout}
        starMap={{ onOpen: noop }}
      />
    </>
  );

  it("draws exactly one Star Map with the strip and thread header both mounted", () => {
    setPlatform("win32");
    render(bothMounted);

    expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
  });

  it("draws exactly one panel-toggle group with both mounted", () => {
    setPlatform("win32");
    render(bothMounted);

    expect(screen.getAllByRole("group", { name: "Window layout" })).toHaveLength(1);
  });

  it("draws exactly one Star Map with the strip and placeholder header both mounted", () => {
    setPlatform("win32");
    render(
      <>
        <AppTitleBar
          layout={titleBarLayout}
          starMap={{ onOpen: noop }}
          actions={titleBarActions}
        />
        <ThreadPlaceholderHeader
          title="Loading..."
          layout={placeholderLayout}
          starMap={{ onOpen: noop }}
        />
      </>,
    );

    expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
  });

  it("gives the Windows strip the window chrome and the header the thread chrome", () => {
    setPlatform("win32");
    render(bothMounted);

    const strip = document.querySelector(".app-titlebar") as HTMLElement;
    const header = document.querySelector(".thread-header") as HTMLElement;

    // Window-scoped: strip only.
    expect(strip.querySelector('[aria-label="Open Star Map"]')).not.toBeNull();
    expect(strip.querySelector(".panel-toggle")).not.toBeNull();
    expect(header.querySelector('[aria-label="Open Star Map"]')).toBeNull();
    expect(header.querySelector(".panel-toggle")).toBeNull();

    // Thread-scoped: header only, including the terminal.
    expect(header.querySelector(".thread-header__terminal-toggle")).not.toBeNull();
    expect(strip.querySelector(".thread-header__terminal-toggle")).toBeNull();
    expect(header.querySelector(".thread-header__breadcrumb")).not.toBeNull();
  });

  it.each(["darwin", "linux"])(
    "leaves the %s header owning the whole cluster (no strip is rendered)",
    (platform) => {
      setPlatform(platform);
      render(bothMounted);

      expect(document.querySelector(".app-titlebar")).toBeNull();
      expect(screen.getAllByRole("group", { name: "Window layout" })).toHaveLength(1);
      expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Open integrated terminal" }),
      ).toBeInTheDocument();
    },
  );

  it("keeps the terminal toggle in the header on every platform", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      setPlatform(platform);
      render(
        <ThreadHeader
          thread={thread}
          layout={threadLayout}
          starMap={{ onOpen: noop }}
        />,
      );
      expect(
        screen.getByRole("button", { name: "Open integrated terminal" }),
      ).toBeInTheDocument();
      cleanup();
    }
  });
});
