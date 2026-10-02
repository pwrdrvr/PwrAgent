/**
 * Appearance — theme + density runtime helpers (renderer side).
 *
 * Source of truth: per-profile `config.toml` `[general.appearance]`
 * block, owned by the main process. The desktop-settings-service
 * resolves it into `DesktopSettingsSnapshot.general.appearance`, the
 * renderer reads it through the existing settings IPC, and writes back
 * via `writeSettingsConfig({ general: { appearance: { theme, density } } })`.
 *
 * The flash-of-wrong-theme path is:
 *   main `readBootstrapAppearance` (sync file read)
 *     → BrowserWindow `additionalArguments`
 *     → preload `contextBridge.exposeInMainWorld("__pwragentAppearance", …)`
 *     → inline `<script>` in index.html sets `<html data-theme/data-density>`
 *     → React mounts with attributes already in place.
 *
 * This file only owns the *runtime* helpers that the React hook uses to
 * push appearance changes through to the DOM and to resolve "system" via
 * `matchMedia`. Persistence is handled by the parent App via writeConfig.
 */

import type {
  DesktopAppearanceDensity,
  DesktopAppearancePalette,
  DesktopAppearanceTheme,
  DesktopTextSize,
} from "@pwragent/shared";
import {
  DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  DESKTOP_APPEARANCE_PALETTE_DEFAULT,
  DESKTOP_APPEARANCE_THEME_DEFAULT,
  DESKTOP_TEXT_SIZE_DEFAULT,
  isDesktopAppearancePalette,
  isDesktopTextSize,
} from "@pwragent/shared";

export type ThemePreference = DesktopAppearanceTheme;
export type PalettePreference = DesktopAppearancePalette;
export type DensityPreference = DesktopAppearanceDensity;
export type TextSizePreference = DesktopTextSize;
export type ResolvedTheme = "dark" | "light";

export type AppearancePreference = {
  theme: ThemePreference;
  palette: PalettePreference;
  density: DensityPreference;
  sidebarTextSize: TextSizePreference;
  transcriptTextSize: TextSizePreference;
};

export const DEFAULT_APPEARANCE: AppearancePreference = {
  theme: DESKTOP_APPEARANCE_THEME_DEFAULT,
  palette: DESKTOP_APPEARANCE_PALETTE_DEFAULT,
  density: DESKTOP_APPEARANCE_DENSITY_DEFAULT,
  sidebarTextSize: DESKTOP_TEXT_SIZE_DEFAULT,
  transcriptTextSize: DESKTOP_TEXT_SIZE_DEFAULT,
};

/** Resolve `"system"` to either `"dark"` or `"light"` by querying the
 *  OS preference. Explicit `"dark"` / `"light"` pass through. Returns
 *  `"dark"` in non-browser environments (e.g. SSR, tests without
 *  matchMedia). */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "dark" || preference === "light") {
    return preference;
  }
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

/** Apply the resolved appearance to `<html>` via data-* attributes.
 *  CSS in app.css picks them up via attribute selectors. Removing the
 *  attribute (when the value is the default) keeps the cascade simple.
 *  `data-theme` stays the scheme (light or absent) whatever the palette,
 *  so scheme-keyed consumers (brand marks, Mermaid) need no palette
 *  knowledge; `data-palette` only recolors the tokens. */
export function applyAppearanceAttributes(
  resolvedTheme: ResolvedTheme,
  palette: PalettePreference,
  density: DensityPreference,
  sidebarTextSize: TextSizePreference,
  transcriptTextSize: TextSizePreference,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolvedTheme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
  if (palette !== DESKTOP_APPEARANCE_PALETTE_DEFAULT) {
    root.setAttribute("data-palette", palette);
  } else {
    root.removeAttribute("data-palette");
  }
  if (density === "compact") {
    root.setAttribute("data-density", "compact");
  } else {
    root.removeAttribute("data-density");
  }
  if (sidebarTextSize !== DESKTOP_TEXT_SIZE_DEFAULT) {
    root.setAttribute("data-sidebar-text", sidebarTextSize);
  } else {
    root.removeAttribute("data-sidebar-text");
  }
  if (transcriptTextSize !== DESKTOP_TEXT_SIZE_DEFAULT) {
    root.setAttribute("data-transcript-text", transcriptTextSize);
  } else {
    root.removeAttribute("data-transcript-text");
  }
}

/**
 * Read the appearance hint that the preload bridged in from main. This
 * mirrors the inline bootstrap script in index.html and is used by the
 * React hook for its initial state before the IPC snapshot arrives. The
 * snapshot — read on settings load — is authoritative; this is just a
 * synchronous bootstrap value.
 */
export function readBridgedAppearance(): AppearancePreference {
  if (typeof window === "undefined") return DEFAULT_APPEARANCE;
  const bridged = (window as unknown as {
    __pwragentAppearance?: Partial<AppearancePreference>;
  }).__pwragentAppearance;
  return {
    theme: normalizeTheme(bridged?.theme),
    palette: normalizePalette(bridged?.palette),
    density: normalizeDensity(bridged?.density),
    sidebarTextSize: normalizeTextSize(bridged?.sidebarTextSize),
    transcriptTextSize: normalizeTextSize(bridged?.transcriptTextSize),
  };
}

function normalizeTheme(value: unknown): ThemePreference {
  return value === "dark" || value === "light" || value === "system"
    ? value
    : DEFAULT_APPEARANCE.theme;
}

function normalizePalette(value: unknown): PalettePreference {
  return typeof value === "string" && isDesktopAppearancePalette(value)
    ? value
    : DEFAULT_APPEARANCE.palette;
}

function normalizeDensity(value: unknown): DensityPreference {
  return value === "compact" || value === "mission-control"
    ? value
    : DEFAULT_APPEARANCE.density;
}

function normalizeTextSize(value: unknown): TextSizePreference {
  return typeof value === "string" && isDesktopTextSize(value)
    ? value
    : DEFAULT_APPEARANCE.sidebarTextSize;
}
