/**
 * Synchronous appearance read for the BrowserWindow bootstrap path.
 *
 * The async settings-snapshot read pulls in app-discovery, codex-discovery,
 * etc. and is much too heavy to run before window creation. We only need
 * theme + density to pass through `webPreferences.additionalArguments` so
 * the preload can expose them to the inline bootstrap script in index.html
 * (which sets data-theme / data-density on `<html>` synchronously before
 * React mounts — avoids flash-of-wrong-theme).
 *
 * This reads `[general.appearance]` directly from the active profile's
 * config.toml. Source of truth is the TOML; the renderer's useAppearance
 * hook writes back via the existing writeSettingsConfig IPC.
 */

import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
} from "@pwragent/shared";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
} from "@pwragent/shared";
import {
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
} from "./desktop-config";

export type BootstrapAppearance = {
  theme: DesktopAppearanceTheme;
  density: DesktopAppearanceDensity;
};

export const BOOTSTRAP_APPEARANCE_ARG_PREFIX = "--pwragent-appearance=";

/**
 * Pre-tinted BrowserWindow `backgroundColor` values. Mirrors the
 * `--bg` token's resolved value in each theme so the OS-level window
 * fill matches the renderer's first paint and we don't flash a dark
 * window before a light renderer (or vice versa). Keep in sync with
 * the `--bg` values in `app.css` `:root` and `:root[data-theme="light"]`.
 */
export const WINDOW_BG_DARK = "#10151f";
export const WINDOW_BG_LIGHT = "#fdfcfa";

/** Pick the right `backgroundColor` for an Electron `BrowserWindow`
 *  based on the resolved appearance. "system" falls back to dark
 *  because we can't resolve `prefers-color-scheme` synchronously
 *  at window-creation time — the renderer's inline bootstrap will
 *  flip the data-theme attribute if it resolves light, and the
 *  brief OS-fill mismatch is preferable to blocking on a media query. */
export function themedWindowBackgroundColor(
  appearance: BootstrapAppearance,
): string {
  return appearance.theme === "light" ? WINDOW_BG_LIGHT : WINDOW_BG_DARK;
}

/** Build the `webPreferences.additionalArguments` array that surfaces
 *  the appearance to the preload script. Every BrowserWindow that
 *  loads the renderer needs this — without it, the preload's
 *  `__pwragentAppearance` resolves to defaults and the window flashes
 *  the wrong theme. */
export function themedWindowAdditionalArguments(
  appearance: BootstrapAppearance,
): string[] {
  return [serializeBootstrapAppearance(appearance)];
}

export function readBootstrapAppearance(
  configPath: string = resolveDesktopConfigPath(),
): BootstrapAppearance {
  try {
    const config = readDesktopSettingsConfig(configPath);
    return {
      theme: config.general?.appearance?.theme ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
      density:
        config.general?.appearance?.density
        ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
    };
  } catch {
    // Config missing / unreadable / malformed → fall back to defaults.
    // The renderer's full settings load will surface the error via its
    // normal error path; this synchronous path is best-effort only.
    return {
      theme: DESKTOP_APPEARANCE_THEME_DEFAULT,
      density: DESKTOP_APPEARANCE_DENSITY_DEFAULT,
    };
  }
}

export function serializeBootstrapAppearance(
  appearance: BootstrapAppearance,
): string {
  return `${BOOTSTRAP_APPEARANCE_ARG_PREFIX}${JSON.stringify(appearance)}`;
}

export function parseBootstrapAppearanceArg(
  argv: readonly string[],
): BootstrapAppearance | undefined {
  for (const arg of argv) {
    if (!arg.startsWith(BOOTSTRAP_APPEARANCE_ARG_PREFIX)) continue;
    try {
      const raw = JSON.parse(arg.slice(BOOTSTRAP_APPEARANCE_ARG_PREFIX.length));
      const theme =
        raw && typeof raw.theme === "string"
          && (raw.theme === "system" || raw.theme === "dark" || raw.theme === "light")
          ? (raw.theme as DesktopAppearanceTheme)
          : DESKTOP_APPEARANCE_THEME_DEFAULT;
      const density =
        raw && typeof raw.density === "string"
          && (raw.density === "mission-control" || raw.density === "compact")
          ? (raw.density as DesktopAppearanceDensity)
          : DESKTOP_APPEARANCE_DENSITY_DEFAULT;
      return { theme, density };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
