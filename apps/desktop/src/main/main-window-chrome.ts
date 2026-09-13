import type { BrowserWindowConstructorOptions } from "electron";
import { macosTitleBarChrome } from "./macos-window-chrome";
import { themedTitleBarOverlay } from "./native-appearance";
import type { BootstrapAppearance } from "./settings/appearance-bootstrap";

export type MainWindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  | "autoHideMenuBar"
  | "titleBarStyle"
  | "titleBarOverlay"
  | "trafficLightPosition"
>;

/**
 * Platform chrome for the shell window. Every platform hides the system title
 * bar so the renderer paints the strip; what differs is who draws the window
 * buttons and where the File/View/Profiles menu lives.
 *
 * - **macOS** keeps its stoplights, inset into our strip at
 *   `MACOS_TRAFFIC_LIGHT_POSITION`. The native menu stays in the system menu
 *   bar at the top of the screen, so the renderer paints no menu bar.
 * - **Windows** reserves the Window Controls Overlay at the right edge and the
 *   OS paints min/max/close into it. The menu bar lived in the title bar we
 *   hid, so the renderer paints the top-level labels (`AppMenuBar`) and pops
 *   the real native submenus through the app-menu bridge.
 * - **Linux** has neither. `titleBarStyle: "hidden"` there is exactly
 *   `frame: false` — `has_frame_{options.ValueOrDefault(kFrame, true) &&
 *   title_bar_style_ == kNormal}` in Electron's `native_window.cc` — and
 *   there is no overlay API, so the renderer paints the caption buttons
 *   itself (`WindowControls.tsx`) alongside the same menu bar Windows uses.
 *
 * Nothing has to suppress a native menu bar on Linux to make room for the
 * painted one, which is why `autoHideMenuBar` is absent below: Electron's
 * `RootView::SetMenu` returns before constructing `menu_bar_` when the window
 * has no frame, and it registers that menu's accelerators BEFORE the early
 * return, so Ctrl+N and Ctrl+, keep working with no bar to hang them on.
 * The inverse is load bearing and lives in `auxiliaryWindowChromeOptions`:
 * a window that KEEPS its frame does need `autoHideMenuBar: true`, because
 * for a framed window `SetMenu` calls `SetMenuBarVisibility(true)` unless
 * auto-hide is set — so every `Menu.setApplicationMenu` rebuild would pop the
 * bar back. Do not make the two "consistent" by dropping it there.
 */
export function mainWindowChromeOptions(
  appearance: BootstrapAppearance,
  platform: NodeJS.Platform = process.platform,
): MainWindowChromeOptions {
  if (platform === "darwin") {
    return macosTitleBarChrome();
  }

  if (platform === "win32") {
    // Frameless + Window Controls Overlay: the OS draws min/max/close in a
    // reserved region at the top-right, themed to match the painted strip.
    // autoHideMenuBar is moot here (no native bar to toggle) but kept true so
    // no phantom native bar can ever appear above our painted one.
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: themedTitleBarOverlay(appearance),
      autoHideMenuBar: true,
    };
  }

  if (platform === "linux") {
    return { titleBarStyle: "hidden" };
  }

  return {};
}
