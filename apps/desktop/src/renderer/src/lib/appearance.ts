/**
 * Appearance — theme + density runtime management.
 *
 * Theme has three modes:
 *   - "system"  — follows prefers-color-scheme; resolves to "dark" | "light"
 *                 at apply time, and re-resolves when the OS theme flips.
 *   - "dark"    — explicit override, ignores prefers-color-scheme.
 *   - "light"   — explicit override, ignores prefers-color-scheme.
 *
 * Density has two modes:
 *   - "mission-control" — current default; full chip rendering in thread
 *                         list rows.
 *   - "compact"         — chips suppressed in list rows; reactions + pin
 *                         markers stay visible.
 *
 * Persistence: source of truth is the per-profile config.toml under
 * [general.appearance], owned by the main process. The renderer mirrors
 * the resolved choice into localStorage.pwragentAppearance so the
 * pre-React bootstrap script in index.html can apply data-theme +
 * data-density attributes synchronously before first paint (avoids
 * flash-of-wrong-theme).
 *
 * IPC wiring (config read/write) lands in Step 3 of issue #472 and
 * connects via desktopApi.readSettings / writeSettingsConfig. The hook
 * below is intentionally IPC-agnostic — it can run on localStorage
 * alone for tests, dev, and the bootstrap path.
 */

export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
export type DensityPreference = "mission-control" | "compact";

export type AppearancePreference = {
  theme: ThemePreference;
  density: DensityPreference;
};

export const DEFAULT_APPEARANCE: AppearancePreference = {
  theme: "system",
  density: "mission-control",
};

/** localStorage key the bootstrap script in index.html reads. Keep in
 *  sync — changing the key requires editing both this file and the
 *  inline script. */
export const APPEARANCE_STORAGE_KEY = "pwragentAppearance";

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
 *  attribute (when the value is the default) keeps the cascade simple. */
export function applyAppearanceAttributes(
  resolvedTheme: ResolvedTheme,
  density: DensityPreference,
): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolvedTheme === "light") {
    root.setAttribute("data-theme", "light");
  } else {
    root.removeAttribute("data-theme");
  }
  if (density === "compact") {
    root.setAttribute("data-density", "compact");
  } else {
    root.removeAttribute("data-density");
  }
}

/** Read the cached appearance preference from localStorage. Returns
 *  defaults if the entry is missing or malformed. */
export function readCachedAppearance(): AppearancePreference {
  if (typeof localStorage === "undefined") return DEFAULT_APPEARANCE;
  try {
    const raw = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<AppearancePreference>;
    return {
      theme: normalizeTheme(parsed.theme),
      density: normalizeDensity(parsed.density),
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Persist the appearance preference to localStorage so the next
 *  bootstrap can apply it synchronously before React mounts. */
export function writeCachedAppearance(preference: AppearancePreference): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(
      APPEARANCE_STORAGE_KEY,
      JSON.stringify({
        theme: preference.theme,
        density: preference.density,
      }),
    );
  } catch {
    /* storage unavailable — fall back to in-memory only. */
  }
}

function normalizeTheme(value: unknown): ThemePreference {
  return value === "dark" || value === "light" || value === "system"
    ? value
    : DEFAULT_APPEARANCE.theme;
}

function normalizeDensity(value: unknown): DensityPreference {
  return value === "compact" || value === "mission-control"
    ? value
    : DEFAULT_APPEARANCE.density;
}
