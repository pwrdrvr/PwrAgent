import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  bringToFront,
  captureWhileFocused,
} from "./fixtures/capture-window-placement";
import { resolveScreenshotAppearance } from "./fixtures/screenshot-appearance";
import {
  pinProfileLastUsed,
  resetDocsSiteStableHomeRoot,
  seedAllMessagingProvidersEnabledConfig,
} from "./fixtures/docs-site-state-seeding";
import {
  findLatestPairingEntryId,
  markPairingObserved,
  seedActivityEntries,
  seedTelegramEnabledConfig,
  stateDbPathForHomeRoot,
  type SeedActivityEntry,
} from "./fixtures/readme-state-seeding";

// docs-site screenshot capture spec.
//
// Produces the native PNGs the docs.pwragent.ai site references.
// The docs themselves live in a SEPARATE repo at
// pwrdrvr/docs.pwragent.ai (split out from this repo on 2026-05-25);
// the capture pipeline stays here because it depends on the desktop
// app's Electron build + replay fixtures + sqlite seeders.
//
// PNGs land in the sibling docs.pwragent.ai checkout's
// `assets/screenshots/` directory. Default location:
// `~/github/docs.pwragent.ai/`. Override with PWRAGENT_DOCS_SITE_REPO
// if your docs checkout lives elsewhere.
//
// Run with:
//   pnpm --filter @pwragent/desktop screenshot:docs-site
//
// Gated behind PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1 so it doesn't
// run in the normal test suite. Screen Recording permission must be
// granted to whatever terminal/IDE runs this; macOS prompts on first
// invocation (the README capture spec triggered that prompt already
// in most setups).

const specDir = path.dirname(fileURLToPath(import.meta.url));
const docsSiteRepo =
  process.env.PWRAGENT_DOCS_SITE_REPO?.replace(/^~(?=$|\/)/, os.homedir()) ??
  path.join(os.homedir(), "github", "docs.pwragent.ai");
const screenshotDir = path.join(docsSiteRepo, "assets", "screenshots");
const captureScript = path.resolve(specDir, "../scripts/capture-window.swift");

const WINDOW_SIZE = { width: 1440, height: 900 } as const;

// Resolved once per spec module from PWRAGENT_SCREENSHOT_THEME /
// PWRAGENT_SCREENSHOT_DENSITY env vars (both optional). Defaults match
// the production E2E defaults (theme=dark, density=mission-control) so
// the committed PNGs stay pixel-stable when neither variable is set.
// See `fixtures/screenshot-appearance.ts` for the env-var contract.
const SCREENSHOT_APPEARANCE = resolveScreenshotAppearance();

/**
 * The wall-clock time a capture shows, wherever it shows one. Captures that
 * use it also launch with `TZ=UTC`, so the time they render does not depend
 * on the timezone of whoever runs the spec.
 */
const DOCS_SITE_CLOCK_TIME = new Date("2026-09-01T16:30:00.000Z");

type DocsSiteApp = Awaited<ReturnType<typeof launchElectronApp>>;

async function launchDocsSiteApp(
  params: Parameters<typeof launchElectronApp>[0],
): Promise<DocsSiteApp> {
  const app = await launchElectronApp({
    ...params,
    // Preserve production-like writable credential controls without allowing
    // unsigned screenshot Electron to invoke the macOS keychain.
    secretStorage: "memory",
  });
  // Put the window on the display it will be captured on before anything
  // scrolls. Chromium snaps a scroll offset to the device pixels of the
  // display the window is on when the scroll lands, and moving the window
  // later does not re-snap it. macOS opens the window on whichever display
  // it likes, so Settings → Messaging → Slack rested at scrollTop 171 when
  // it opened on a 1x monitor and 170.5 when it opened on the Retina
  // panel, and the per-capture `bringToFront` then photographed the same
  // screen one device pixel apart.
  //
  // Callers only close the app from their own `finally`, which a throw here
  // would skip.
  try {
    await bringToFront(app.electronApp);
    await holdMotionStill(app.window);
  } catch (error) {
    await app.close();
    throw error;
  }
  return app;
}

/**
 * Stop the two things that move on their own clock, so a capture cannot land
 * on a different frame of either from one run to the next.
 *
 * - Reduced motion parks every thinking scanner on the pose `app.css` gives
 *   it for that preference: centred, at full opacity. Running, the beam
 *   sweeps an 1800ms loop pinned to the document timeline, so where it sat
 *   in `desktop-queued-turns` and `desktop-live-work-rail` depended on how
 *   long the run took to reach the capture.
 * - The text caret blinks on Chromium's own timer, so a focused composer
 *   came out with or without it. It is hidden the way Playwright's own
 *   screenshots hide it (`caret: "hide"`).
 *
 * Both outlast a reload: the page keeps its emulated media, and the caret
 * rule is also installed as an init script.
 */
async function holdMotionStill(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(hideTextCaret);
  await page.evaluate(hideTextCaret);
}

/** Runs in the page, so it can only use what the page has. */
function hideTextCaret(): void {
  const install = (): void => {
    const style = document.createElement("style");
    style.textContent =
      "*, *::before, *::after { caret-color: transparent !important; }";
    document.documentElement.append(style);
  };
  // An init script runs before the document has an element to append to.
  if (document.documentElement) {
    install();
  } else {
    document.addEventListener("DOMContentLoaded", install, { once: true });
  }
}

/**
 * Pin the wall clock in both processes to `time`.
 *
 * A turn sent from the composer stamps its user message and its live diff
 * row with `Date.now()`, so `desktop-queued-turns` and
 * `desktop-live-work-rail` showed whatever minute the spec ran in. This follows `visual-regression.spec.ts`: main is pinned
 * as well, because IPC read deadlines cross the two processes and have to
 * share an epoch, and the window reloads so that nothing admitted before
 * the change ends up in the capture.
 */
async function pinWallClock(app: DocsSiteApp, time: Date): Promise<void> {
  await app.electronApp.evaluate((_electron, now) => {
    // Playwright evaluates in a separate VM context. Patch the application's
    // realm, since its IPC deadlines use that realm's Date constructor.
    const { runInThisContext } = process.getBuiltinModule("vm");
    runInThisContext(`Date.now = () => ${now}`);
  }, time.getTime());
  await app.window.clock.setFixedTime(time);
  await app.window.reload();
  expect(await app.window.evaluate(() => Date.now())).toBe(time.getTime());
}

/** What the thread context panel's "Initial load" row shows in a capture. */
const PINNED_INITIAL_LOAD = "1 ms";

/**
 * Show `PINNED_INITIAL_LOAD` in the thread context panel's "Initial load" row.
 *
 * The row reports how long the thread's first read took, and the replay
 * answers it in 0 or 1 ms from one run to the next. `visual-regression.spec.ts`
 * normalizes the same row for the same reason.
 */
async function pinInitialLoad(page: Page): Promise<void> {
  const duration = page
    .getByText("Initial load", { exact: true })
    .locator("xpath=following-sibling::dd");
  await expect(duration).toBeVisible();
  await duration.evaluate((element, text) => {
    element.textContent = text;
  }, PINNED_INITIAL_LOAD);
}

/**
 * Resolve once main's startup provider refresh has settled. That refresh
 * runs Codex discovery and the ACP CLI discovery that fills the provider
 * catalog cache. A navigation query page reports it as `coverage`, which
 * stays "checking" until both finish.
 *
 * Coverage also reads "complete" before the refresh has recorded any state,
 * but main records "checking" while it prewarms the thread list right after
 * creating the window, well before the launch harness reports the renderer
 * ready. Every probe run saw "checking" first.
 */
async function waitForStartupProviderRefresh(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        await page.evaluate(async () => {
          const bridge = globalThis as typeof globalThis & {
            pwragent?: {
              getNavigationQueryPage?: (request: unknown) => Promise<{
                coverage?: { state: string };
              }>;
            };
          };
          const queryPage = await bridge.pwragent?.getNavigationQueryPage?.({
            protocol: 2,
            consumer: "settings",
            query: { kind: "directory-index" },
            pageSize: 1,
          });
          return queryPage?.coverage?.state ?? "unavailable";
        }),
      {
        message: "startup provider refresh did not settle",
        timeout: 30_000,
      },
    )
    .toMatch(/^(?:complete|degraded)$/);
}

test.skip(
  process.env.PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE !== "1",
  "Set PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1 via the package script to capture docs-site screenshots.",
);

// Sanity-check the docs-site checkout exists before any capture runs.
// Refuses to silently create PNGs in a random directory if the docs
// repo isn't where we expect it.
if (process.env.PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE === "1") {
  if (!existsSync(docsSiteRepo)) {
    throw new Error(
      `docs.pwragent.ai checkout not found at ${docsSiteRepo}. ` +
        `Clone pwrdrvr/docs.pwragent.ai there, or set ` +
        `PWRAGENT_DOCS_SITE_REPO to point at your checkout.`,
    );
  }
}

async function captureNative(
  electronApp: ElectronApplication,
  outputBasename: string,
  options?: { titleSubstring?: string },
): Promise<void> {
  mkdirSync(screenshotDir, { recursive: true });
  const outputPath = path.join(screenshotDir, outputBasename);
  const args = ["Electron", outputPath];
  if (options?.titleSubstring) {
    args.push(`--title=${options.titleSubstring}`);
  }
  // The Swift script refuses a sub-Retina capture and tells the operator to
  // "Pass --allow-low-dpi" — which is only actionable if something here can
  // pass it. On a 1x-only machine (external-display-only desk, a VM, the
  // Tart lab guest) this is the difference between a documented override
  // and one that requires editing the spec.
  if (process.env.PWRAGENT_SCREENSHOT_ALLOW_LOW_DPI === "1") {
    args.push("--allow-low-dpi");
  }
  await captureWhileFocused(
    () => execFileSync(captureScript, args, { stdio: "inherit" }),
    () => bringToFront(electronApp, options?.titleSubstring),
  );
}

/**
 * Click Open Settings, then click the section button in the left nav,
 * then wait for the matching pane region to be visible.
 *
 * The region's `aria-label` follows the SettingsSectionStack convention
 * in apps/desktop/src/renderer/src/features/settings/*Settings.tsx —
 * "Application settings", "Worktree settings", "Model settings",
 * "Messaging settings".
 */
async function openSettingsSection(
  page: Page,
  params: { navLabel: string; regionLabel: string },
): Promise<void> {
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();

  // Exact, so a group's "Expand <label>" caret toggle doesn't also match.
  const navButton = page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: params.navLabel, exact: true });
  await expect(navButton).toBeVisible();
  await navButton.click();

  await expect(page.getByRole("region", { name: params.regionLabel })).toBeVisible();
}

/**
 * From the Settings → Messaging hub, open the named platform's focused
 * screen via its index row (Telegram, Discord, Slack, Mattermost,
 * Feishu / Lark, LINE), then wait for the platform's own pane region.
 */
async function openMessagingPlatformScreen(
  page: Page,
  platformLabel: string,
): Promise<void> {
  const hub = page.getByRole("region", { name: "Messaging settings" });
  await expect(hub).toBeVisible();
  await hub
    .getByRole("button", { name: `Open ${platformLabel} settings` })
    .click();

  const region = page.getByRole("region", {
    name: `${platformLabel} messaging settings`,
  });
  await expect(region).toBeVisible();
  const platformHeading = region
    .getByRole("heading", { name: platformLabel })
    .first();
  await platformHeading.waitFor({ state: "visible", timeout: 10_000 });
  await new Promise((resolve) => setTimeout(resolve, 250));
  await waitForSettingsScrollToSettle(page);
}

/** Consecutive rendered frames the pane must hold one `scrollTop` for. */
const SCROLL_SETTLE_FRAMES = 10;

/**
 * Resolve once the Settings scroll pane has held the same `scrollTop` for
 * `SCROLL_SETTLE_FRAMES` rendered frames in a row.
 *
 * A platform screen opens with a nav focus request, which SettingsLayout
 * answers with a smooth `scrollIntoView`. The animation ran 230–265ms from
 * the click and creeps its last pixels one frame at a time, which the fixed
 * 250ms settle above does not cover. Captures only landed after it because
 * `bringToFront` and the Swift capture add latency of their own. Emulating
 * `reducedMotion` would not shorten it: Chromium animates a smooth
 * `scrollIntoView` either way. Counting frames rather than milliseconds also
 * keeps a stalled (occluded, unpainted) window from passing as settled.
 */
async function waitForSettingsScrollToSettle(page: Page): Promise<void> {
  await page.locator(".settings-content").evaluate(
    (pane, stableFrames) =>
      new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error(
              `Settings scroll pane still moving after 5s (scrollTop ${pane.scrollTop})`,
            ),
          );
        }, 5_000);
        let last = pane.scrollTop;
        let still = 0;
        const tick = () => {
          const top = pane.scrollTop;
          still = top === last ? still + 1 : 0;
          last = top;
          if (still >= stableFrames) {
            clearTimeout(timeout);
            resolve();
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    SCROLL_SETTLE_FRAMES,
  );
}

// ────────────────────── Settings — non-messaging ──────────────────────

test("settings-applications — Settings → Applications panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Applications",
      regionLabel: "Application settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-applications.png");
  } finally {
    await app.close();
  }
});

test("settings-worktrees — Settings → Worktrees panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    // The panel prints its effective path, which sits under the home root.
    homeRoot: resetDocsSiteStableHomeRoot(),
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Worktrees",
      regionLabel: "Worktree settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-worktrees.png");
  } finally {
    await app.close();
  }
});

test("settings-models — Settings → AI Providers panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    // The provider index reads main's cached provider catalog once, as it
    // mounts. Main fills that cache from its startup discovery of installed
    // CLIs, which finished before the pane opened on some runs and after on
    // others: the same Mac captured Kimi, Grok, Qwen and Gemini as "Not
    // installed" once and as "Discovered" with versions the next time. Open
    // the pane only after startup discovery settles. A fresh home runs no
    // capability probe after it, so nothing rewrites the cache before the
    // capture. The rows still show whichever CLIs this Mac has installed.
    await waitForStartupProviderRefresh(app.window);

    await openSettingsSection(app.window, {
      navLabel: "AI Providers",
      regionLabel: "Model settings",
    });

    // Wait for the index to render its rows, then give it the same settle
    // window the messaging shots use.
    await expect(
      app.window.getByRole("button", { name: "Open Codex settings" }),
    ).toBeVisible();
    await expect(
      app.window.getByText("Discovering AI providers…"),
    ).toHaveCount(0);
    await new Promise((resolve) => setTimeout(resolve, 250));

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-models.png");
  } finally {
    await app.close();
  }
});

test("settings-profiles — Settings → Profiles panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    env: { TZ: "UTC" },
  });

  try {
    // The profile card prints "Last used <date>, <time>", which main stamps
    // with the launch time.
    pinProfileLastUsed(app.homeRoot, "default", DOCS_SITE_CLOCK_TIME);
    await app.window.reload();

    await openSettingsSection(app.window, {
      navLabel: "Profiles",
      regionLabel: "Profile settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-profiles.png");
  } finally {
    await app.close();
  }
});

test("settings-general — Settings → General panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "General",
      regionLabel: "General settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-general.png");
  } finally {
    await app.close();
  }
});

// Release controls moved out of General onto their own nav row, which left
// `settings-general.png` showing a card that is no longer there and nothing
// documenting where it went. Re-run `screenshot:docs-site` to refresh both.
test("settings-updates — Settings → Updates panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Updates",
      regionLabel: "Update settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-updates.png");
  } finally {
    await app.close();
  }
});

test("settings-experimental — Settings → Experimental panel", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Experimental",
      regionLabel: "Experimental settings",
    });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "settings-experimental.png");
  } finally {
    await app.close();
  }
});

// ────────────────────── Settings → Messaging → each provider ──────────────────────

const MESSAGING_PLATFORM_SHOTS = [
  { label: "Telegram", filename: "settings-messaging-telegram.png" },
  { label: "Discord", filename: "settings-messaging-discord.png" },
  { label: "Slack", filename: "settings-messaging-slack.png" },
  { label: "Mattermost", filename: "settings-messaging-mattermost.png" },
  { label: "Feishu / Lark", filename: "settings-messaging-feishu.png" },
  { label: "LINE", filename: "settings-messaging-line.png" },
] as const;

for (const shot of MESSAGING_PLATFORM_SHOTS) {
  test(`settings-messaging — ${shot.label}`, async () => {
    test.setTimeout(120_000);

    const app = await launchDocsSiteApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
      windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
      preLaunchHook: seedAllMessagingProvidersEnabledConfig,
    });

    try {
      await openSettingsSection(app.window, {
        navLabel: "Messaging",
        regionLabel: "Messaging settings",
      });

      await openMessagingPlatformScreen(app.window, shot.label);

      const platformRegion = app.window.getByRole("region", {
        name: `${shot.label} messaging settings`,
      });
      await expect(
        platformRegion.locator('input[type="password"]:disabled'),
      ).toHaveCount(0);
      await expect(
        platformRegion.getByText(/Secret storage disabled via/i),
      ).toHaveCount(0);

      await bringToFront(app.electronApp);
      await captureNative(app.electronApp, shot.filename);
    } finally {
      await app.close();
    }
  });
}

// ────────────────────── Messaging — Pairing flow (3 frames) ──────────────────────

// Sanitized persona used for the pairing approval / authorized-user
// row. Matches the README pairing-GIF persona so the docs-site +
// README screenshots tell a coherent fictional story (no real IDs).
const PAIRING_PERSONA = {
  displayName: "Riley Chen",
  username: "rileychen",
  telegramPeerId: "5550199999",
} as const;

/** Shown in place of the generated token. Drawn from the token alphabet. */
const PINNED_PAIRING_TOKEN = "Rk7mQ2vXw9HcTzP4nYb3JdLf8sGaEu6h";

/**
 * Show `PINNED_PAIRING_TOKEN` in place of the token Generate produced.
 *
 * Main draws each token from `randomBytes` and hands it to the renderer only
 * in the Generate response. sqlite keeps just its HMAC, so there is no row a
 * seeder could write that the Pairing field would display. The text is
 * swapped in the DOM instead, as `visual-regression.spec.ts` does for its
 * measured "Initial load" duration. The swap keeps the command word and
 * checks the token length, so the capture keeps the layout the app produced.
 */
async function pinPairingToken(page: Page): Promise<void> {
  const pairCode = page.locator(".settings-pairing__message code").first();
  await pairCode.evaluate((code, pinned) => {
    const shown = code.textContent ?? "";
    const match = /^(\S+) (\S+)$/.exec(shown);
    if (!match || match[2].length !== pinned.length) {
      throw new Error(`unexpected pairing message: ${JSON.stringify(shown)}`);
    }
    code.textContent = `${match[1]} ${pinned}`;
  }, PINNED_PAIRING_TOKEN);
}

/**
 * Drive the renderer from the main shell into Settings → Messaging
 * with the Telegram Pairing field scrolled into the center of the
 * viewport. Used for every frame of the pairing capture so each
 * frame frames the same surface area.
 */
async function navigateToTelegramPairing(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Open settings" })).toBeVisible();
  await page.getByRole("button", { name: "Open settings" }).click();

  const messagingNav = page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Messaging", exact: true });
  await messagingNav.click();
  await expect(
    page.getByRole("region", { name: "Messaging settings" }),
  ).toBeVisible();

  // Pairing lives on Telegram's focused screen behind the hub index.
  await page.getByRole("button", { name: "Open Telegram settings" }).click();
  await expect(
    page.getByRole("region", { name: "Telegram messaging settings" }),
  ).toBeVisible();

  const pairingTarget = page
    .getByRole("radiogroup", { name: /^Telegram pairing target$/i })
    .first();
  await pairingTarget.waitFor({ state: "visible" });
  // Opening the screen starts a smooth scroll to its Connect section. Let it
  // finish, so it can't race the instant scroll below for the final framing.
  await waitForSettingsScrollToSettle(page);
  await pairingTarget.evaluate((node) => {
    node.scrollIntoView({ behavior: "instant", block: "center" });
  });
  await expect(pairingTarget).toBeInViewport();
}

test("messaging-pairing — frame 1: pairing token generated", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    preLaunchHook: seedTelegramEnabledConfig,
  });

  try {
    await navigateToTelegramPairing(app.window);

    // Click the Telegram-section Generate button. Two `Generate`
    // buttons render in the panel (one per platform pairing field);
    // scope to the Telegram section by anchoring on its radiogroup.
    const telegramGenerateButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: /^Generate$/ });
    await telegramGenerateButton.click();

    // Wait for the pair code to render. The renderer puts the
    // generated token inside a `<code>` element under the Pairing
    // field's `.settings-pairing__message` row.
    const pairingMessage = app.window
      .locator(".settings-pairing__message")
      .first();
    const pairCode = pairingMessage.locator("code");
    await expect(pairCode).toBeVisible({ timeout: 10_000 });

    // Generate also copies the code and shows "Copied" for 1.5s. Capture
    // after it reverts, rather than on whichever side of that the capture
    // happens to land.
    await expect(
      pairingMessage.getByRole("button", { name: "Copy", exact: true }),
    ).toBeVisible();
    await pinPairingToken(app.window);

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "messaging-pairing-frame-1.png");
  } finally {
    await app.close();
  }
});

test("messaging-pairing — frame 2: observed, approval prompt visible", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    preLaunchHook: seedTelegramEnabledConfig,
  });

  try {
    await navigateToTelegramPairing(app.window);

    // Generate a pairing token first so a row exists in sqlite to
    // mutate to "observed".
    const telegramGenerateButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: /^Generate$/ });
    await telegramGenerateButton.click();
    await expect(
      app.window.locator(".settings-pairing__message code").first(),
    ).toBeVisible({ timeout: 10_000 });

    // Mutate the row directly to "observed" with our sanitized
    // persona (mimicking the user having sent the pair code to the
    // bot from a Telegram DM). Reload so PairingTokenField re-fetches
    // from sqlite.
    const stateDbPath = stateDbPathForHomeRoot(app.homeRoot);
    const entryId = findLatestPairingEntryId(stateDbPath, "telegram");
    if (!entryId) {
      throw new Error(
        "no telegram pairing entry found after Generate click — runtime may not have written to sqlite",
      );
    }
    markPairingObserved(stateDbPath, entryId, {
      observedActor: {
        id: PAIRING_PERSONA.telegramPeerId,
        username: PAIRING_PERSONA.username,
        displayName: PAIRING_PERSONA.displayName,
      },
      observedChat: {
        id: PAIRING_PERSONA.telegramPeerId,
        kind: "dm",
        title: PAIRING_PERSONA.displayName,
      },
    });
    await app.window.reload();
    await navigateToTelegramPairing(app.window);

    // Wait for the Approve button to appear (status === "observed"
    // entries render an Approve action).
    const telegramApproveButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: "Approve" });
    await expect(telegramApproveButton).toBeVisible({ timeout: 10_000 });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "messaging-pairing-frame-2.png");
  } finally {
    await app.close();
  }
});

test("messaging-pairing — frame 3: approved, user in authorized list", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    preLaunchHook: seedTelegramEnabledConfig,
  });

  try {
    await navigateToTelegramPairing(app.window);

    // Generate, mark observed, reload — same as frame 2 setup.
    const telegramGenerateButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: /^Generate$/ });
    await telegramGenerateButton.click();
    await expect(
      app.window.locator(".settings-pairing__message code").first(),
    ).toBeVisible({ timeout: 10_000 });

    const stateDbPath = stateDbPathForHomeRoot(app.homeRoot);
    const entryId = findLatestPairingEntryId(stateDbPath, "telegram");
    if (!entryId) {
      throw new Error(
        "no telegram pairing entry found after Generate click — runtime may not have written to sqlite",
      );
    }
    markPairingObserved(stateDbPath, entryId, {
      observedActor: {
        id: PAIRING_PERSONA.telegramPeerId,
        username: PAIRING_PERSONA.username,
        displayName: PAIRING_PERSONA.displayName,
      },
      observedChat: {
        id: PAIRING_PERSONA.telegramPeerId,
        kind: "dm",
        title: PAIRING_PERSONA.displayName,
      },
    });
    await app.window.reload();
    await navigateToTelegramPairing(app.window);

    // Click Approve. The IPC handler patches config.toml to add the
    // user to authorized_users, marks the pairing entry consumed,
    // and refreshes the settings snapshot. The Approve prompt
    // disappears and the user appears in the Authorized User IDs
    // list below.
    const telegramApproveButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: "Approve" });
    await expect(telegramApproveButton).toBeVisible({ timeout: 10_000 });
    await telegramApproveButton.click();

    // Wait for the Authorized User IDs row to display the user id
    // input populated with the seeded user.
    await expect(
      app.window
        .locator(`input[value="${PAIRING_PERSONA.telegramPeerId}"]`)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Re-scroll so the Pairing field stays at center (the
    // Authorized User IDs field is just below it so this puts both
    // in frame).
    await app.window
      .getByRole("radiogroup", { name: /^Telegram pairing target$/i })
      .first()
      .evaluate((node) => {
        node.scrollIntoView({ behavior: "instant", block: "center" });
      });

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "messaging-pairing-frame-3.png");
  } finally {
    await app.close();
  }
});

// ────────────────────── Messaging — Activity surface (troubleshooting) ──────────────────────

test("messaging-activity-blocked — Messaging Activity showing rejected inbound", async () => {
  test.setTimeout(120_000);

  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    preLaunchHook: seedTelegramEnabledConfig,
  });

  try {
    // Wait for the main shell so the schema has migrated and the
    // IPC bridge is wired before we mutate sqlite.
    await expect(
      app.window.getByRole("button", { name: "Open settings" }),
    ).toBeVisible();

    // Seed a handful of rejected inbound entries on a few platforms
    // so the capture demonstrates what an operator sees when a
    // messenger user tries to talk to the bot before pairing has
    // authorized them. All actor IDs are sanitized fictional values.
    const stateDbPath = stateDbPathForHomeRoot(app.homeRoot);
    const now = Date.now();
    const minute = 60_000;
    const entries: SeedActivityEntry[] = [
      {
        platform: "telegram",
        kind: "inbound-rejected",
        conversationId: "5550199999",
        conversationTitle: "Riley Chen",
        actorId: "5550199999",
        actorDisplayName: "Riley Chen",
        summary: "Rejected inbound from Riley Chen",
        createdAt: now - 3 * minute,
        payload: { conversationKind: "dm" },
      },
      {
        platform: "telegram",
        kind: "inbound-rejected",
        conversationId: "5550288888",
        conversationTitle: "Casey Wong",
        actorId: "5550288888",
        actorDisplayName: "Casey Wong",
        summary: "Rejected inbound from Casey Wong",
        createdAt: now - 9 * minute,
        payload: {
          conversationKind: "topic",
          conversationParentId: "-1009990000001",
          conversationBucketId: "-1009990000001",
        },
      },
      {
        platform: "discord",
        kind: "inbound-rejected",
        conversationId: "1100000000000000001",
        conversationTitle: "design-chat",
        actorId: "9000000000000000001",
        actorDisplayName: "Jordan Lee",
        summary: "Rejected inbound from Jordan Lee",
        createdAt: now - 17 * minute,
        payload: { conversationKind: "channel" },
      },
      {
        platform: "slack",
        kind: "inbound-rejected",
        conversationId: "C0FAKE002",
        conversationTitle: "design-chat",
        actorId: "U0FAKE001",
        actorDisplayName: "Morgan Patel",
        summary: "Rejected inbound from Morgan Patel",
        createdAt: now - 22 * minute,
        payload: { conversationKind: "channel" },
      },
    ];
    seedActivityEntries(stateDbPath, entries);

    // Open the Messaging Activity window via the preload bridge.
    await app.window.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pwragent.openMessagingActivityWindow();
    });

    // Wait until the window with `messaging-activity` in the URL
    // exists. The window is created with show: false and shown on
    // ready-to-show, so poll until it's a real Page object.
    let activityWindow: import("@playwright/test").Page | undefined;
    for (let i = 0; i < 30; i++) {
      for (const candidate of app.electronApp.windows()) {
        if (candidate.url().includes("messaging-activity")) {
          activityWindow = candidate;
          break;
        }
      }
      if (activityWindow) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!activityWindow) {
      throw new Error(
        `messaging activity window did not open; current windows: ${app.electronApp
          .windows()
          .map((w) => w.url())
          .join(", ")}`,
      );
    }
    await activityWindow.waitForLoadState("load");

    // Same title the capture below passes as `--title=`, so placement and
    // raise both act on the window that actually gets photographed.
    await bringToFront(app.electronApp, "Messaging Activity");

    // Two nested regions share `aria-label="Messaging activity"`
    // (the outer window shell and the inner screen); .first() pins
    // to the outermost.
    await expect(
      activityWindow
        .getByRole("region", { name: "Messaging activity" })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      activityWindow.getByText(/Rejected inbound from Riley Chen/).first(),
    ).toBeVisible();

    await captureNative(app.electronApp, "messaging-activity-blocked.png", {
      titleSubstring: "Messaging Activity",
    });
  } finally {
    await app.close();
  }
});

// ────────────────────── Desktop — Recents lens ──────────────────────

test("desktop-recents — Recents lens populated", async () => {
  test.setTimeout(120_000);

  // Reuse the README's hand-crafted populated Recents fixture so the
  // sidebar shows realistic thread titles rather than the smoke
  // fixture's blank state. The capture goes to docs-site/ under a
  // different filename so the docs-site/ folder is self-contained.
  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await expect(
      app.window.getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      }),
    ).toBeVisible();
    await app.window
      .getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Migrate auth from JWT to session cookies",
      }),
    ).toBeVisible();
    await pinInitialLoad(app.window);

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "desktop-recents.png");
  } finally {
    await app.close();
  }
});

// ────────────────────── Composer feature captures ──────────────────────

test("desktop-skills-autocomplete — composer $ autocomplete showing skill list", async () => {
  test.setTimeout(120_000);

  // Reuse the dedicated skill-autocomplete fixture — it ships with a
  // realistic skill set (ce:plan, ce:brainstorm, ce:compound, ce:work,
  // adversarial-document-reviewer, …) so the dropdown reads as a
  // believable Codex setup rather than a synthetic stub.
  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/skill-autocomplete-interactions/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await app.window
      .getByRole("button", { name: /Skill autocomplete replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Skill autocomplete replay",
      }),
    ).toBeVisible();

    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.focus();
    // Type a realistic prefix before `$ce` so the screenshot looks
    // like a real composer mid-thought, not an isolated dropdown.
    await app.window.keyboard.type("Let's use ");
    await app.window.keyboard.type("$ce");

    // Wait for the Skills listbox; this is what we actually want to
    // capture.
    await expect(
      app.window.getByRole("listbox", { name: "Skills" }),
    ).toBeVisible();
    await pinInitialLoad(app.window);

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "desktop-skills-autocomplete.png");
  } finally {
    await app.close();
  }
});

test("desktop-queued-turns — composer with /review queued behind an in-flight turn", async () => {
  test.setTimeout(120_000);

  // Inline fixture: one thread, in-flight turn, no git repo (the
  // queued-review-release spec needs a real repo because it tests
  // branch adoption; we just need the visual queue state).
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const tmpRoot = await mkdtemp(
    path.join(os.tmpdir(), "pwragent-docs-site-queue-"),
  );
  const fixturePath = path.join(tmpRoot, "docs-site-queue.fixture.json");
  await writeFile(
    fixturePath,
    JSON.stringify(
      {
        metadata: {
          backend: "codex",
          scenario: "docs-site-queued-turns",
        },
        steps: [
          {
            id: "initialize-1",
            kind: "response",
            method: "initialize",
            result: {
              serverInfo: { name: "Replay Codex", version: "1.0.0" },
              methods: ["thread/list", "thread/read", "turn/start"],
            },
          },
          {
            id: "thread-list-1",
            kind: "response",
            method: "thread/list",
            result: [
              {
                id: "thread-active",
                title: "Convert OAuth flow to PKCE",
                titleSource: "explicit",
                summary:
                  "make a branch and PR, then queue /review behind it",
                source: "codex",
                executionMode: "default",
                gitBranch: "main",
                linkedDirectories: [],
                updatedAt: 2_000,
              },
            ],
          },
          {
            id: "thread-read-1",
            kind: "response",
            method: "thread/read",
            result: {
              entries: [],
              messages: [],
              pagination: { supportsPagination: false, hasPreviousPage: false },
            },
          },
          {
            id: "turn-start-1",
            kind: "response",
            method: "turn/start",
            result: {
              threadId: "thread-active",
              turnId: "turn-active",
            },
          },
          {
            id: "turn-started-1",
            kind: "notification",
            notification: {
              method: "turn/started",
              params: {
                threadId: "thread-active",
                turnId: "turn-active",
                turn: { id: "turn-active", status: "inProgress" },
              },
            },
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const app = await launchDocsSiteApp({
    fixturePath,
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    env: { TZ: "UTC" },
  });

  try {
    // The message sent below stamps its time in the transcript header.
    await pinWallClock(app, DOCS_SITE_CLOCK_TIME);

    await app.window
      .getByRole("button", { name: /Convert OAuth flow to PKCE/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Convert OAuth flow to PKCE",
      }),
    ).toBeVisible();

    // Send the first message; this fires turn/start and stays in
    // "starting" state until we advance the notification.
    const textbox = app.window.getByRole("textbox", { name: "Reply" });
    await textbox.fill("make a branch and PR for the OAuth refactor");
    await app.window.getByRole("button", { name: "Send" }).click();

    // Advance to in-flight; this swaps the composer's Send button to
    // Queue and enables follow-up queueing.
    await app.advance({ stepId: "turn-started-1" });

    // Queue /review main — the headline of the docs section. Bare
    // `/review` opens the composer's inline review-target picker
    // (the ReviewConfig fieldset) and doesn't queue until a target
    // is chosen; `/review main` parses as a complete
    // review-against-base command and queues with the friendly
    // "Review changes against main" label.
    await textbox.fill("/review main");
    await app.window.getByRole("button", { name: "Queue" }).click();
    await expect(
      app.window.getByLabel("Queued message", { exact: true }),
    ).toContainText("Review changes against main");

    // Stack a second queued follow-up so the screenshot shows the
    // FIFO-deep-queue capability, not just a single chip.
    await textbox.fill("now squash and push --force-with-lease");
    await app.window.getByRole("button", { name: "Queue" }).click();
    await expect(
      app.window.getByLabel("Queued message 2", { exact: true }),
    ).toContainText("now squash and push --force-with-lease");
    await pinInitialLoad(app.window);

    await bringToFront(app.electronApp);
    // Check both chips again after placement, right before the capture.
    // The review waits in main's pending-review list rather than the turn
    // FIFO, and the renderer reconciles its chips against main after they
    // appear. That reconciliation has dropped the review chip, and has moved
    // it behind the squash, after both asserts above had passed. `exact`,
    // because a bare "Queued message" also matches "Queued message 2" and
    // passed on 2026-09-25 with only the squash chip left.
    await expect(
      app.window.getByLabel("Queued message", { exact: true }),
    ).toContainText("Review changes against main");
    await expect(
      app.window.getByLabel("Queued message 2", { exact: true }),
    ).toContainText("now squash and push --force-with-lease");
    await captureNative(app.electronApp, "desktop-queued-turns.png");
  } finally {
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

// ────────────────────── First-run onboarding wizard ──────────────────────

test("desktop-onboarding-wizard — Codex profile step", async () => {
  test.setTimeout(120_000);

  // No fixturePath: the wizard runs against a fresh PWRAGENT_HOME (no
  // ~/.pwragent/profiles/default/ pre-seeded), so the boot decision
  // returns `no-profile-configured` and the wizard fires for real.
  // `suppressOnboarding: false` is the explicit opt-in, and the
  // wizard doesn't need the replay driver until it tries to spawn a
  // thread (which we won't do — we stop on the Codex Profile step).
  const app = await launchDocsSiteApp({
    suppressOnboarding: false,
    requiresReplayDriver: false,
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    env: { PWRAGENT_CODEX_COMMAND: process.execPath },
  });

  try {
    // Welcome → Thread presentation → AI Providers → Codex
    // profile. The Codex profile step is the most distinctive shot —
    // it shows the Shared / Isolated / Multiple cards that frame how
    // PwrAgent relates to a Codex install.
    await expect(
      app.window.getByRole("heading", { name: /A few short choices/i }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: /Get started/i }).click();

    // Thread presentation — accept defaults.
    await expect(
      app.window.getByRole("heading", {
        name: /Pick your appearance and thread density/i,
      }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: /^Continue/i }).click();

    // AI Providers — the deterministic executable override clears the
    // gate without collecting credentials in the wizard.
    await expect(
      app.window.getByRole("heading", {
        name: /Install at least one AI provider/i,
      }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: /^Continue/i }).click();

    // Codex profile — this is the screenshot target.
    await expect(
      app.window.getByRole("heading", {
        name: /How should PwrAgent relate to your Codex install/i,
      }),
    ).toBeVisible();

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "desktop-onboarding-codex-profile.png");
  } finally {
    await app.close();
  }
});

// ────────────────────── Live work rail ──────────────────────

test("desktop-live-work-rail — in-flight turn with diff + plan in the rail", async () => {
  test.setTimeout(120_000);

  // Reuses the existing live-work-rail-toggle fixture from the e2e
  // test suite. That fixture's turn/diff/updated landing ends with
  // the protocol-summary "Edited 2 files, +4, -1" — a tight, visually
  // interesting state for the rail.
  const app = await launchDocsSiteApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-toggle/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
    env: { TZ: "UTC" },
  });

  try {
    // The turn sent below stamps the time on its user message and its
    // "Edited 2 files" row.
    await pinWallClock(app, DOCS_SITE_CLOCK_TIME);

    await app.window
      .getByRole("button", { name: /LiveWorkRail chevron toggle replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "LiveWorkRail chevron toggle replay",
      }),
    ).toBeVisible();

    // Kick the turn so the rail populates with diff + plan content.
    await app.window
      .getByLabel("Reply")
      .fill("Make a small disposable edit to two files.");
    await app.window.getByRole("button", { name: "Send" }).click();

    // Advance the replay through the diff lifecycle.
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-diff-updated-1" });

    // The rail's landmark name reflects the cumulative diff summary.
    await expect(
      app.window.getByRole("complementary", { name: /Edited 2 files/i }),
    ).toBeVisible();
    await pinInitialLoad(app.window);

    await bringToFront(app.electronApp);
    await captureNative(app.electronApp, "desktop-live-work-rail.png");
  } finally {
    await app.close();
  }
});
