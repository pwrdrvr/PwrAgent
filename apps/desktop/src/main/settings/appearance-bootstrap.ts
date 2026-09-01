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
  DesktopTextSize,
} from "@pwragent/shared";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  isDesktopTextSize,
} from "@pwragent/shared";
import {
  readDesktopSettingsConfig,
  resolveDesktopConfigPath,
} from "./desktop-config";
import { getExistingDesktopConfigStore } from "./config-store/desktop-config-store-singleton";

export type BootstrapAppearance = {
  theme: DesktopAppearanceTheme;
  density: DesktopAppearanceDensity;
  sidebarTextSize: DesktopTextSize;
  transcriptTextSize: DesktopTextSize;
};

export const BOOTSTRAP_APPEARANCE_ARG_PREFIX = "--pwragent-appearance=";

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
  configPath?: string,
): BootstrapAppearance {
  if (!configPath) {
    const storeAppearance = getExistingDesktopConfigStore()?.read("general").appearance;
    if (storeAppearance) {
      return storeAppearance;
    }
  }
  try {
    const config = readDesktopSettingsConfig(configPath ?? resolveDesktopConfigPath());
    return {
      theme: config.general?.appearance?.theme ?? DESKTOP_APPEARANCE_THEME_DEFAULT,
      density:
        config.general?.appearance?.density
        ?? DESKTOP_APPEARANCE_DENSITY_DEFAULT,
      sidebarTextSize:
        config.general?.appearance?.sidebarTextSize
        ?? DESKTOP_TEXT_SIZE_DEFAULT,
      transcriptTextSize:
        config.general?.appearance?.transcriptTextSize
        ?? DESKTOP_TEXT_SIZE_DEFAULT,
    };
  } catch {
    // Config missing / unreadable / malformed → fall back to defaults.
    // The renderer's full settings load will surface the error via its
    // normal error path; this synchronous path is best-effort only.
    return {
      theme: DESKTOP_APPEARANCE_THEME_DEFAULT,
      density: DESKTOP_APPEARANCE_DENSITY_DEFAULT,
      sidebarTextSize: DESKTOP_TEXT_SIZE_DEFAULT,
      transcriptTextSize: DESKTOP_TEXT_SIZE_DEFAULT,
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
      const sidebarTextSize =
        raw && typeof raw.sidebarTextSize === "string"
          && isDesktopTextSize(raw.sidebarTextSize)
          ? raw.sidebarTextSize
          : DESKTOP_TEXT_SIZE_DEFAULT;
      const transcriptTextSize =
        raw && typeof raw.transcriptTextSize === "string"
          && isDesktopTextSize(raw.transcriptTextSize)
          ? raw.transcriptTextSize
          : DESKTOP_TEXT_SIZE_DEFAULT;
      return { theme, density, sidebarTextSize, transcriptTextSize };
    } catch {
      return undefined;
    }
  }
  return undefined;
}
