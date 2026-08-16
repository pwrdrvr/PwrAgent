import { BrowserWindow, nativeTheme } from "electron";
import type { BootstrapAppearance } from "./settings/appearance-bootstrap";
import { readBootstrapAppearance } from "./settings/appearance-bootstrap";

/**
 * Pre-tinted BrowserWindow `backgroundColor` values. Mirrors the
 * `--bg` token's resolved value in each theme so the OS-level window
 * fill matches the renderer's first paint and we don't flash a dark
 * window before a light renderer (or vice versa). Keep in sync with
 * the `--bg` values in app.css `:root` and `:root[data-theme="light"]`.
 */
export const WINDOW_BG_DARK = "#10151f";
export const WINDOW_BG_LIGHT = "#fdfcfa";

/**
 * Title-bar (caption-button strip) background. This MUST match the renderer's
 * painted title strip — `.app-titlebar`, which fills `var(--bg-sidebar)`, NOT
 * the page background — so the native min/max/close buttons blend seamlessly
 * into our chrome instead of sitting on a slightly-off rectangle (most visible
 * in light theme: pure white behind cream). Keep in sync with `--bg-sidebar`
 * in app.css (`:root` and `:root[data-theme="light"]`).
 */
export const TITLE_BAR_BG_DARK = "#050505";
export const TITLE_BAR_BG_LIGHT = "#f7f4ef";

// Keep in sync with `--win-titlebar-h` in app.css so the OS caption buttons
// and the painted menu bar share one line.
export const TITLE_BAR_OVERLAY_HEIGHT = 40;

function resolvedNativeTheme(
  appearance: BootstrapAppearance,
): "dark" | "light" {
  if (appearance.theme === "dark" || appearance.theme === "light") {
    return appearance.theme;
  }
  return nativeTheme.shouldUseDarkColors ? "dark" : "light";
}

/** Pick the right `backgroundColor` for an Electron `BrowserWindow`.
 *  The main process can resolve "system" synchronously through
 *  `nativeTheme`, matching the renderer's `prefers-color-scheme`. */
export function themedWindowBackgroundColor(
  appearance: BootstrapAppearance,
): string {
  return resolvedNativeTheme(appearance) === "light"
    ? WINDOW_BG_LIGHT
    : WINDOW_BG_DARK;
}

/**
 * Window Controls Overlay (Windows) styling for the frameless title bar.
 * `color` paints behind the OS-drawn caption buttons; `symbolColor` paints
 * their glyphs; `height` aligns them with the renderer's title bar.
 */
export function themedTitleBarOverlay(appearance: BootstrapAppearance): {
  color: string;
  symbolColor: string;
  height: number;
} {
  const light = resolvedNativeTheme(appearance) === "light";
  return {
    color: light ? TITLE_BAR_BG_LIGHT : TITLE_BAR_BG_DARK,
    symbolColor: light ? "#3a3a3a" : "#c8ccd4",
    height: TITLE_BAR_OVERLAY_HEIGHT,
  };
}

/** Re-color every overlay-capable window after the OS appearance changes. */
export function refreshWindowsTitleBarOverlays(): void {
  if (process.platform !== "win32") return;
  const overlay = themedTitleBarOverlay(readBootstrapAppearance());
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      window.setTitleBarOverlay(overlay);
    } catch {
      // Frameless windows without Window Controls Overlay support are skipped.
    }
  }
}

let systemAppearanceListenerInstalled = false;

/** Install the one process-wide listener that keeps "system" chrome current. */
export function installWindowsTitleBarAppearanceSync(): void {
  if (process.platform !== "win32" || systemAppearanceListenerInstalled) return;
  systemAppearanceListenerInstalled = true;
  nativeTheme.on("updated", refreshWindowsTitleBarOverlays);
}
