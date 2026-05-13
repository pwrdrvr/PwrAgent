import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { seedAllMessagingProvidersEnabledConfig } from "./fixtures/docs-site-state-seeding";

// docs-site screenshot capture spec.
//
// Produces the native PNGs the docs.pwragent.ai site references under
// `docs-site/assets/screenshots/`. Mirrors the README screenshot spec
// at `readme-screenshots.inspect.spec.ts` but targets the docs-site
// output directory and a different set of surfaces (Settings panels +
// a workspace Recents hero).
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
const repoRoot = path.resolve(specDir, "../../..");
const screenshotDir = path.join(repoRoot, "docs-site/assets/screenshots");
const captureScript = path.resolve(specDir, "../scripts/capture-window.swift");

const WINDOW_SIZE = { width: 1440, height: 900 } as const;

test.skip(
  process.env.PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE !== "1",
  "Set PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1 via the package script to capture docs-site screenshots.",
);

async function bringToFront(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.show();
    win.focus();
    win.moveTop();
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function captureNative(outputBasename: string): void {
  mkdirSync(screenshotDir, { recursive: true });
  const outputPath = path.join(screenshotDir, outputBasename);
  execFileSync(captureScript, ["Electron", outputPath], { stdio: "inherit" });
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

  const navButton = page
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: params.navLabel });
  await expect(navButton).toBeVisible();
  await navButton.click();

  await expect(page.getByRole("region", { name: params.regionLabel })).toBeVisible();
}

/**
 * Scroll the named platform section within Settings → Messaging into
 * the center of the viewport, then capture. Each per-platform section
 * is rendered with a heading containing the platform name (Telegram,
 * Discord, Slack, Mattermost, Feishu / Lark, LINE).
 */
async function scrollMessagingPlatformIntoView(
  page: Page,
  platformLabel: string,
): Promise<void> {
  const region = page.getByRole("region", { name: "Messaging settings" });
  await expect(region).toBeVisible();

  // The platform header is rendered as a heading within the messaging
  // section stack. Use a text locator scoped to the region so we
  // don't catch matches elsewhere on the page.
  const platformHeading = region.getByText(platformLabel, { exact: true }).first();
  await platformHeading.waitFor({ state: "visible", timeout: 10_000 });
  await platformHeading.evaluate((node) => {
    node.scrollIntoView({ behavior: "instant", block: "center" });
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// ────────────────────── Settings — non-messaging ──────────────────────

test("settings-applications — Settings → Applications panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Applications",
      regionLabel: "Application settings",
    });

    await bringToFront(app.electronApp);
    captureNative("settings-applications.png");
  } finally {
    await app.close();
  }
});

test("settings-worktrees — Settings → Worktrees panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Worktrees",
      regionLabel: "Worktree settings",
    });

    await bringToFront(app.electronApp);
    captureNative("settings-worktrees.png");
  } finally {
    await app.close();
  }
});

test("settings-models — Settings → Models panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Models",
      regionLabel: "Model settings",
    });

    await bringToFront(app.electronApp);
    captureNative("settings-models.png");
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

    const app = await launchElectronApp({
      fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
      windowSize: WINDOW_SIZE,
      preLaunchHook: seedAllMessagingProvidersEnabledConfig,
    });

    try {
      await openSettingsSection(app.window, {
        navLabel: "Messaging",
        regionLabel: "Messaging settings",
      });

      await scrollMessagingPlatformIntoView(app.window, shot.label);

      await bringToFront(app.electronApp);
      captureNative(shot.filename);
    } finally {
      await app.close();
    }
  });
}

// ────────────────────── Desktop — Recents lens ──────────────────────

test("desktop-recents — Recents lens populated", async () => {
  test.setTimeout(120_000);

  // Reuse the README's hand-crafted populated Recents fixture so the
  // sidebar shows realistic thread titles rather than the smoke
  // fixture's blank state. The capture goes to docs-site/ under a
  // different filename so the docs-site/ folder is self-contained.
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
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

    await bringToFront(app.electronApp);
    captureNative("desktop-recents.png");
  } finally {
    await app.close();
  }
});
