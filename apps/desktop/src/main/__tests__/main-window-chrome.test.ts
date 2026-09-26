import { describe, expect, it } from "vitest";
import { macosTitleBarChrome } from "../macos-window-chrome";
import { mainWindowChromeOptions } from "../main-window-chrome";
import type { BootstrapAppearance } from "../settings/appearance-bootstrap";

const appearance = {
  theme: "dark",
  density: "mission-control",
  sidebarTextSize: "medium",
  transcriptTextSize: "medium",
} as unknown as BootstrapAppearance;

/**
 * The shell window's per-platform chrome. Every branch is pure, which is the
 * point of the module existing: none of this is checkable from the platform a
 * developer happens to be sitting on, so it is checked from all four here.
 */
describe("main window chrome", () => {
  it("gives macOS the shared stoplight chrome and nothing of its own", () => {
    // Not "looks like" it — the same object the auxiliary windows spread, so
    // the two cannot drift into different traffic-light positions. The
    // duplicate-numbers failure this prevents is what
    // `macos-window-chrome.test.ts` was written for.
    expect(mainWindowChromeOptions(appearance, "darwin")).toEqual(
      macosTitleBarChrome(),
    );
  });

  it("gives Windows a frameless window with a themed controls overlay", () => {
    const chrome = mainWindowChromeOptions(appearance, "win32");

    expect(chrome.titleBarStyle).toBe("hidden");
    expect(chrome.titleBarOverlay).toMatchObject({ height: expect.any(Number) });
    // Moot under a hidden title bar, kept so no phantom native bar can appear
    // above the painted one.
    expect(chrome.autoHideMenuBar).toBe(true);
  });

  it("gives Linux a square frameless window and nothing else", () => {
    // `titleBarStyle: "hidden"` on Linux IS `frame: false` —
    // `has_frame_{options.ValueOrDefault(kFrame, true) && title_bar_style_ ==
    // kNormal}` in Electron's shell/browser/native_window.cc. There is no
    // controls overlay to theme and no stoplights to place. Since Electron 43
    // `roundedCorners` defaults to true on Linux too; the renderer paints a
    // square edge hairline, so the corners stay square.
    expect(mainWindowChromeOptions(appearance, "linux")).toEqual({
      titleBarStyle: "hidden",
      roundedCorners: false,
    });
  });

  it("does NOT set autoHideMenuBar on Linux", () => {
    // This is the half that is easy to "make consistent" and wrong to.
    // Electron's `RootView::SetMenu` returns before constructing `menu_bar_`
    // when the window has no frame, so there is no native bar to hide — and it
    // registers the menu's accelerators BEFORE that early return, so they keep
    // working. The INVERSE is load bearing and lives in
    // `auxiliaryWindowChromeOptions`: a framed window needs the flag, because
    // `SetMenu` calls `SetMenuBarVisibility(true)` on one unless auto-hide is
    // set, and every `Menu.setApplicationMenu` rebuild would pop the bar back.
    expect(mainWindowChromeOptions(appearance, "linux")).not.toHaveProperty(
      "autoHideMenuBar",
    );
  });

  it("leaves an unknown platform with the native frame", () => {
    // Nothing paints a strip there, so hiding the title bar would take the
    // window's only buttons with it.
    expect(mainWindowChromeOptions(appearance, "freebsd")).toEqual({});
  });
});
