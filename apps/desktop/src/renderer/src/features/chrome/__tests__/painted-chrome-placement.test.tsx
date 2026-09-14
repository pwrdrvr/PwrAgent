import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { AppTitleBar } from "../AppTitleBar";
import { ThreadHeader } from "../../thread-detail/ThreadHeader";
import { ThreadPlaceholderHeader } from "../../thread-detail/ThreadPlaceholderHeader";

/**
 * The painted title strip and the view header are mounted at the same time, so
 * a control drawn by both appears twice on screen. That is not hypothetical:
 * both rendered a Star Map button and Windows shipped with two of them.
 *
 * The rule these tests pin — window chrome lives in ONE place per platform:
 *
 *   win32   strip:  wordmark, menu, app actions, panel toggles, Star Map, MSG
 *   linux   header: history, breadcrumb, chips, terminal
 *   darwin  strip:  not rendered at all
 *           header: all of it
 *
 * Linux joined the strip when its window went frameless: `titleBarStyle:
 * "hidden"` is `frame: false` there, which takes the native menu bar with it,
 * so the strip is the only home left for the menu — and for the caption
 * buttons, which Linux alone has to paint. macOS keeps its system menu bar and
 * its stoplights, so it keeps the header.
 *
 * The terminal toggle is the one control in the cluster that stays in the
 * header everywhere, because its state is per-thread (running dot, per-thread
 * disabled reason); putting it in a global strip would drag thread state up
 * into it.
 *
 * Checked against the pre-fix components, three of these fail: both Star Map
 * counting cases and the win32 ownership case, all because the header drew an
 * unguarded Star Map beside the strip's. The others pass there — the panel
 * toggles were already strip-owned on win32, and the terminal and the macOS
 * behavior are unchanged by that fix. They are here to hold those halves of
 * the rule in place, not because they caught anything.
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
  threadSearchActive: false,
  creatingThread: false,
  onToggleThreadSearch: noop,
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

const STRIP_PLATFORMS = ["win32", "linux"] as const;

describe("painted chrome placement", () => {
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

  it.each(STRIP_PLATFORMS)(
    "draws exactly one Star Map on %s with the strip and thread header both mounted",
    (platform) => {
      setPlatform(platform);
      render(bothMounted);

      expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
    },
  );

  it.each(STRIP_PLATFORMS)(
    "draws exactly one panel-toggle group on %s with both mounted",
    (platform) => {
      setPlatform(platform);
      render(bothMounted);

      expect(screen.getAllByRole("group", { name: "Window layout" })).toHaveLength(1);
    },
  );

  it.each(STRIP_PLATFORMS)(
    "draws exactly one Star Map on %s with the strip and placeholder header both mounted",
    (platform) => {
      setPlatform(platform);
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
    },
  );

  it.each(STRIP_PLATFORMS)(
    "gives the %s strip the window chrome and the header the thread chrome",
    (platform) => {
    setPlatform(platform);
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
    },
  );

  it("leaves the macOS header owning the whole cluster (no strip is rendered)", () => {
    setPlatform("darwin");
    render(bothMounted);

    expect(document.querySelector(".app-titlebar")).toBeNull();
    expect(screen.getAllByRole("group", { name: "Window layout" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Open Star Map" })).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Open integrated terminal" }),
    ).toBeInTheDocument();
  });

  // The sidebar masthead is hidden on these platforms (app.css), so the strip
  // is the only home left for the window-level actions. Search was the one
  // that never made it in — Windows has been missing it since the strip
  // shipped, and porting Linux onto the strip would have taken it away there
  // too, silently, on the platform that keeps the sidebar's button today.
  it.each(STRIP_PLATFORMS)(
    "carries the whole masthead action set on %s",
    (platform) => {
      setPlatform(platform);
      render(
        <AppTitleBar layout={titleBarLayout} actions={titleBarActions} />,
      );

      const actions = document.querySelector(
        ".app-titlebar__actions",
      ) as HTMLElement;
      for (const name of [
        "Search threads",
        "Open automations",
        "Open settings",
        "New thread",
      ]) {
        expect(
          actions.querySelector(`[aria-label="${name}"]`),
          `the strip should carry ${name}`,
        ).not.toBeNull();
      }
    },
  );

  // Linux is the only platform with no OS-drawn window buttons: macOS floats
  // its stoplights and Windows fills a controls overlay, so a duplicate set
  // there would sit beside the real ones. A missing set on Linux is worse than
  // a duplicate anywhere — the window would have no way to close itself.
  it("paints caption buttons on Linux and nowhere else", () => {
    for (const platform of ["win32", "darwin", "linux"]) {
      setPlatform(platform);
      render(
        <AppTitleBar
          layout={titleBarLayout}
          starMap={{ onOpen: noop }}
          actions={titleBarActions}
        />,
      );

      const expected = platform === "linux" ? 1 : 0;
      for (const name of ["Minimize", "Maximize", "Close"]) {
        expect(screen.queryAllByRole("button", { name })).toHaveLength(expected);
      }
      cleanup();
    }
  });

  // The fatal and startup app states drop `layout` and `actions`, so the
  // strip's right cluster is not rendered at all. The caption buttons are
  // outside it for that reason: a window with no close button is not a state
  // to ship.
  it("keeps the Linux caption buttons in the stripped-down startup strip", () => {
    setPlatform("linux");
    render(<AppTitleBar />);

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
    expect(document.querySelector(".app-titlebar__right")).toBeNull();
  });

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
