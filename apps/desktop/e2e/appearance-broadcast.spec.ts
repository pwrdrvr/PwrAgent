import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Cross-window appearance broadcast contract.
 *
 * When the user changes theme or density in Settings, the main process
 * fans an `APPEARANCE_CHANGED_EVENT_CHANNEL` event out to every open
 * BrowserWindow that subscribed (every window, currently). Each window's
 * renderer applies the resolved `<html data-theme/data-density>`
 * attributes from `main.tsx`. The main window also adopts via its
 * useAppearance hook, but secondary windows have no React layer for
 * appearance — they rely entirely on the broadcast to flip.
 *
 * Pre-existing unit coverage validates the settings-service callback
 * fires correctly; this spec is the integration test that proves the
 * IPC channel + per-window subscription + DOM apply work end-to-end
 * across two BrowserWindow processes.
 */
test("broadcasts theme + density changes to a secondary window", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
  });

  try {
    // E2E default seeds dark theme + mission-control density (see
    // `electron-app.ts`). Both windows should start there.
    await expect.poll(() => readThemeAttribute(app.window)).toBe(null);
    await expect.poll(() => readDensityAttribute(app.window)).toBe(null);

    // Open the changelog window via the preload bridge. It's the
    // simplest secondary window — no live messaging or polling deps,
    // just reads the bundled CHANGELOG markdown. The window registers
    // APPEARANCE_CHANGED_EVENT_CHANNEL so it should track theme changes
    // we make in the main window.
    await app.window.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pwragent.openChangelogWindow();
    });

    const changelogWindow = await waitForWindowByUrlHash(app, "changelog");

    // Both windows bootstrapped from the same TOML (dark default), so
    // neither has data-theme set (bare :root carries dark in app.css).
    await expect.poll(() => readThemeAttribute(changelogWindow)).toBe(null);
    await expect.poll(() => readDensityAttribute(changelogWindow)).toBe(null);

    // Drive a theme change from the main window via writeSettingsConfig.
    // This is what Settings → General → Appearance does internally.
    // After the write, the settings service fires onAppearanceChange
    // which the production wiring routes to broadcastAppearanceChange,
    // sending APPEARANCE_CHANGED_EVENT_CHANNEL to every subscriber.
    await app.window.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pwragent.writeSettingsConfig({
        patch: {
          general: { appearance: { theme: "light", density: "compact" } },
        },
      });
    });

    // Main window: useAppearance hook adopts the snapshot update on
    // its own React state path. Verify it ends up applied to DOM.
    await expect.poll(() => readThemeAttribute(app.window)).toBe("light");
    await expect.poll(() => readDensityAttribute(app.window)).toBe("compact");

    // Changelog window: no useAppearance hook — only path to update
    // is the broadcast → main.tsx subscription → applyAppearanceAttributes.
    // This is the assertion the broadcast wiring exists to make true.
    await expect.poll(() => readThemeAttribute(changelogWindow)).toBe("light");
    await expect
      .poll(() => readDensityAttribute(changelogWindow))
      .toBe("compact");

    // Flip back to dark explicitly — verifies the broadcast handles
    // both directions (not just one-way light-on). Using `"dark"`
    // rather than `"system"` keeps the assertion deterministic: the
    // CI runner's `matchMedia(prefers-color-scheme: light)` resolves
    // differently across distros / Chromium versions, so `"system"`
    // could land on either theme and the assertion would flake.
    await app.window.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pwragent.writeSettingsConfig({
        patch: {
          general: {
            appearance: { theme: "dark", density: "mission-control" },
          },
        },
      });
    });

    // Explicit dark → no data-theme attribute (the bare :root carries
    // dark). Mission-control density is the bare default too.
    await expect.poll(() => readThemeAttribute(app.window)).toBe(null);
    await expect.poll(() => readDensityAttribute(app.window)).toBe(null);
    await expect.poll(() => readThemeAttribute(changelogWindow)).toBe(null);
    await expect.poll(() => readDensityAttribute(changelogWindow)).toBe(null);
  } finally {
    await app.close();
  }
});

async function readThemeAttribute(page: Page): Promise<string | null> {
  return await page.evaluate(() =>
    document.documentElement.getAttribute("data-theme"),
  );
}

async function readDensityAttribute(page: Page): Promise<string | null> {
  return await page.evaluate(() =>
    document.documentElement.getAttribute("data-density"),
  );
}

/**
 * Poll `electronApp.windows()` for a window whose URL contains the
 * given hash. Mirrors the pattern in `readme-screenshots.inspect.spec.ts`
 * — BrowserWindow is created with `show: false` so Playwright's
 * `window` event fires before the URL has loaded; polling sidesteps
 * the race.
 */
async function waitForWindowByUrlHash(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
  hash: string,
): Promise<Page> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    for (const candidate of app.electronApp.windows()) {
      if (candidate.url().includes(`#${hash}`)) {
        return candidate;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `Window with hash "#${hash}" did not open; current windows: ${app.electronApp
      .windows()
      .map((win) => win.url())
      .join(", ")}`,
  );
}
