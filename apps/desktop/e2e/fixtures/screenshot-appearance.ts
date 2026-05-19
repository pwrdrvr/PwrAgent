/**
 * Resolve the appearance (theme + density) that the screenshot inspect
 * specs should launch under.
 *
 * Reads two env vars, both optional:
 *   - PWRAGENT_SCREENSHOT_THEME: "dark" | "light" | "system"
 *   - PWRAGENT_SCREENSHOT_DENSITY: "mission-control" | "compact"
 *
 * Defaults match what `launchElectronApp` already does for every E2E
 * launch (theme=dark, density=mission-control) — the committed PNGs
 * under `docs/assets/screenshots/` and `docs-site/assets/screenshots/`
 * were all captured under those defaults, so omitting the env vars
 * keeps the existing pipeline pixel-stable.
 *
 * Setting either variable just flows the value through into
 * `launchElectronApp({ appearance: { theme, density } })`, which seeds
 * the per-test profile's `[general.appearance]` block before Electron
 * launches. From there the pre-React bootstrap (main → preload →
 * inline script) applies the matching `<html data-*>` attributes on
 * the first paint — no UI driving required to flip the theme.
 *
 * Example:
 *   PWRAGENT_SCREENSHOT_CAPTURE=1 \
 *     PWRAGENT_SCREENSHOT_THEME=light \
 *     pnpm --filter @pwragent/desktop screenshot:readme
 *
 * Scope is intentionally the screenshot inspect specs only — production
 * E2E retains its dark default unconditionally so color-assertion tests
 * stay deterministic on every CI runner.
 */

import type {
  DesktopAppearanceDensity,
  DesktopAppearanceTheme,
} from "@pwragent/shared";

export type ScreenshotAppearance = {
  theme: DesktopAppearanceTheme;
  density: DesktopAppearanceDensity;
};

const SCREENSHOT_THEME_ENV = "PWRAGENT_SCREENSHOT_THEME";
const SCREENSHOT_DENSITY_ENV = "PWRAGENT_SCREENSHOT_DENSITY";

function parseTheme(value: string | undefined): DesktopAppearanceTheme {
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "dark";
}

function parseDensity(value: string | undefined): DesktopAppearanceDensity {
  if (value === "compact" || value === "mission-control") {
    return value;
  }
  return "mission-control";
}

export function resolveScreenshotAppearance(
  env: NodeJS.ProcessEnv = process.env,
): ScreenshotAppearance {
  return {
    theme: parseTheme(env[SCREENSHOT_THEME_ENV]),
    density: parseDensity(env[SCREENSHOT_DENSITY_ENV]),
  };
}
