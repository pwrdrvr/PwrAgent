import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  seedActivityEntries,
  seedTelegramBinding,
  stateDbPathForHomeRoot,
  type SeedActivityEntry,
} from "./fixtures/readme-state-seeding";

// README screenshot capture spec.
//
// Produces the native PNGs the top-level README references under
// `docs/assets/screenshots/`. Each test drives one fixture into a stable
// UI state and then shells out to `apps/desktop/scripts/capture-window.swift`
// — a Swift helper that resolves the Electron window's CGWindowID and
// calls `/usr/sbin/screencapture -l <wid>`. We can't use Playwright's
// `Page.screenshot()` here because it only captures the rendered DOM
// inside the BrowserWindow — no stoplights, no rounded corners, no drop
// shadow. The README's whole point is to look like a real macOS app, so
// native capture is the only option.
//
// Run with:
//   pnpm --filter @pwragent/desktop screenshot:readme
//
// The script gates itself behind PWRAGENT_SCREENSHOT_CAPTURE=1 so it
// doesn't run in the normal test suite (each test launches a full
// Electron app and writes binary files into the docs tree). Screen
// Recording permission must be granted to whatever terminal/IDE runs
// this; macOS prompts on first invocation.

const specDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(specDir, "../../..");
const screenshotDir = path.join(repoRoot, "docs/assets/screenshots");
const captureScript = path.resolve(
  specDir,
  "../scripts/capture-window.swift",
);

const WINDOW_SIZE = { width: 1440, height: 900 } as const;

test.skip(
  process.env.PWRAGENT_SCREENSHOT_CAPTURE !== "1",
  "Set PWRAGENT_SCREENSHOT_CAPTURE=1 via the package script to capture README screenshots.",
);

/**
 * Bring the Electron window forward so screencapture's window-list lookup
 * resolves it. Without this, a recently-launched Electron window can
 * stay behind whatever the user/IDE had focused, and `screencapture -l`
 * silently captures a stale frame or an off-screen position.
 */
async function bringToFront(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    win.show();
    win.focus();
    win.moveTop();
  });
  // Give the compositor a tick to actually raise the window before
  // screencapture inspects the on-screen window list.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function captureNative(
  outputBasename: string,
  options?: { titleSubstring?: string },
): void {
  mkdirSync(screenshotDir, { recursive: true });
  const outputPath = path.join(screenshotDir, outputBasename);
  const args = ["Electron", outputPath];
  if (options?.titleSubstring) {
    args.push(`--title=${options.titleSubstring}`);
  }
  execFileSync(captureScript, args, {
    stdio: "inherit",
  });
}

test("recents-hero — populated Recents lens", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    // Wait for the Recents sidebar to be populated with the fixture's
    // threads — the hero shot only works once the list has rendered.
    await expect(
      app.window.getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", {
        name: /Wire ship-changelog window/i,
      }),
    ).toBeVisible();

    // Auto-select the primary thread so the right pane shows a real
    // transcript rather than an empty welcome state.
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
    captureNative("screenshot-recents-hero.png");
  } finally {
    await app.close();
  }
});

test("closed-by-default — Messaging Activity rejecting unauthorized inbound", async () => {
  test.setTimeout(120_000);

  // Boot any fixture that gets the app to a stable shell — the
  // Messaging Activity surface is renderer-routed and reads from
  // sqlite (`messaging_activity_log`), not from protocol replay.
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    // Wait for the main shell so we know the schema has been migrated.
    await expect(
      app.window.getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      }),
    ).toBeVisible();

    const stateDbPath = stateDbPathForHomeRoot(app.homeRoot);

    // Seed a binding row first so the routed entries can reference it
    // (binding_id is otherwise nullable but the chip looks more honest
    // when the routed entry has somewhere to point).
    const bindingId = seedTelegramBinding({
      stateDbPath,
      threadId: "thread-recents-hero-primary",
      conversationTitle: "Hunt",
    });

    // Seed activity rows that mirror the user's reference screenshot:
    // two routed Telegram inbound events (so the "Bound activity"
    // section is populated), one rejected Slack inbound (so the
    // "Attention" section shows the closed-by-default story), and one
    // diagnostic event (Slow Mode dropped) for color.
    const now = Date.now();
    const minute = 60_000;
    const hour = 60 * minute;
    const entries: SeedActivityEntry[] = [
      {
        platform: "telegram",
        kind: "inbound-routed",
        threadId: "thread-recents-hero-primary",
        bindingId,
        conversationId: "953",
        actorId: "8460800771",
        actorDisplayName: "Harold Hunt",
        summary: "Inbound from Harold Hunt",
        createdAt: now - 19 * hour,
        payload: {
          conversationKind: "topic",
          conversationParentId: "-1003841603622",
          conversationBucketId: "-1003841603622",
        },
      },
      {
        platform: "telegram",
        kind: "inbound-routed",
        threadId: "thread-recents-hero-primary",
        bindingId,
        conversationId: "6690",
        actorId: "8460800771",
        actorDisplayName: "Harold Hunt",
        summary: "Inbound from Harold Hunt",
        createdAt: now - 20 * hour,
        payload: {
          conversationKind: "topic",
          conversationParentId: "-1003841603622",
          conversationBucketId: "-1003841603622",
        },
      },
      {
        platform: "slack",
        kind: "inbound-rejected",
        conversationId: "G01N9LZU287",
        conversationTitle: "signals-chat",
        actorId: "UA6R99D0A",
        actorDisplayName: "Vitaliy Morarian",
        summary: "Rejected inbound from Vitaliy Morarian",
        createdAt: now - 4 * hour,
        payload: { conversationKind: "channel" },
      },
      {
        platform: "telegram",
        kind: "diagnostic",
        summary: "Slow Mode dropped routine_status: slow-mode",
        createdAt: now - 4 * hour - 3 * minute,
        payload: {},
      },
      {
        platform: "telegram",
        kind: "diagnostic",
        summary: "Slow Mode dropped stream_partial: budget-exhausted",
        createdAt: now - 4 * hour - 6 * minute,
        payload: {},
      },
    ];
    seedActivityEntries(stateDbPath, entries);

    // Open the Messaging Activity window via the preload bridge. The
    // bridge is exposed as `window.pwragent` (see preload/index.ts).
    await app.window.evaluate(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (window as any).pwragent.openMessagingActivityWindow();
    });

    // The activity window loads the same renderer bundle with a
    // `#messaging-activity` hash. Poll the electronApp's open windows
    // until that one shows up (Playwright's "window" event fires on
    // creation but `BrowserWindow` is created with `show: false` and
    // shown later on `ready-to-show`, so wait for the page that's
    // actually displaying the activity surface).
    let activityWindow: import("@playwright/test").Page | undefined;
    for (let i = 0; i < 30; i++) {
      for (const candidate of app.electronApp.windows()) {
        const url = candidate.url();
        if (url.includes("messaging-activity")) {
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

    // Diagnostic: confirm the activity window actually mounted its
    // hash-routed surface (and not the full app shell).
    const surfaceInfo = await activityWindow.evaluate(() => ({
      hash: window.location.hash,
      title: document.title,
      hasActivityScreen: !!document.querySelector(".activity-screen"),
      hasApp: !!document.querySelector(".app"),
      bodyChildren: document.body.children.length,
      rootHTML: document
        .getElementById("root")
        ?.innerHTML.slice(0, 200),
    }));
    test
      .info()
      .annotations.push({
        type: "activity-window-surface",
        description: JSON.stringify(surfaceInfo),
      });
    if (!surfaceInfo.hasActivityScreen) {
      throw new Error(
        `activity window did not mount the activity surface: ${JSON.stringify(surfaceInfo)}`,
      );
    }

    // Bring the activity window to front so it's actually visible on
    // screen. The BrowserWindow was created with `show: false` and is
    // normally shown on `ready-to-show`, but during automated capture
    // we want to be explicit so `toBeVisible` checks succeed and
    // `screencapture -l` finds the window in the on-screen list.
    await app.electronApp.evaluate(({ BrowserWindow }, titleSubstring) => {
      const win = BrowserWindow.getAllWindows().find((w) =>
        w.getTitle().includes(titleSubstring),
      );
      if (!win) return;
      win.show();
      win.focus();
      win.moveTop();
    }, "Messaging Activity");
    await new Promise((resolve) => setTimeout(resolve, 500));

    // The Activity screen polls `listMessagingActivity` on mount, so
    // the seeded rows land on the first frame. Two nested sections
    // share `aria-label="Messaging activity"` (the outer
    // MessagingActivityWindow shell and the inner MessagingActivityScreen)
    // so `.first()` is required to pin to the outermost.
    await expect(
      activityWindow
        .getByRole("region", { name: "Messaging activity" })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      activityWindow.getByText(/Inbound from Harold Hunt/).first(),
    ).toBeVisible();
    await expect(
      activityWindow.getByText(/Rejected inbound from Vitaliy Morarian/),
    ).toBeVisible();

    captureNative("screenshot-closed-by-default.png", {
      titleSubstring: "Messaging Activity",
    });
  } finally {
    await app.close();
  }
});

test("messenger-status — Settings → Messaging surface", async () => {
  test.setTimeout(120_000);

  // Reuse the smoke fixture — Settings is renderer-routed and doesn't
  // depend on protocol replay state. Any fixture that gets the app to
  // a stable boot is fine.
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/smoke/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    // Wait for the main shell to render before navigating into Settings.
    await expect(
      app.window.getByRole("button", { name: "Open settings" }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: "Open settings" }).click();

    // Settings nav: click the Messaging row.
    const messagingNav = app.window
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Messaging" });
    await expect(messagingNav).toBeVisible();
    await messagingNav.click();

    // Wait for the Messaging panel itself, identified by its labeled
    // SettingsSectionStack region.
    await expect(
      app.window.getByRole("region", { name: "Messaging settings" }),
    ).toBeVisible();

    await bringToFront(app.electronApp);
    captureNative("screenshot-messenger-status.png");
  } finally {
    await app.close();
  }
});

test("pairing — Settings → Messaging pairing card", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/smoke/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    await expect(
      app.window.getByRole("button", { name: "Open settings" }),
    ).toBeVisible();
    await app.window.getByRole("button", { name: "Open settings" }).click();

    const messagingNav = app.window
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Messaging" });
    await messagingNav.click();
    await expect(
      app.window.getByRole("region", { name: "Messaging settings" }),
    ).toBeVisible();

    // Scroll the first per-platform "Pairing" field into view so the
    // capture frames the pairing UI rather than the top-of-panel
    // general settings (which is what `messenger-status` already
    // captures). The MessagingSettings panel renders one
    // `PairingTokenField` per platform, each as a radiogroup labeled
    // "<Platform> pairing target". Telegram is the first one in the
    // panel's render order; if that changes, we still pick the first
    // pairing-target radiogroup present.
    const pairingTarget = app.window
      .getByRole("radiogroup", { name: /pairing target$/i })
      .first();
    await pairingTarget.waitFor({ state: "visible" });
    await pairingTarget.evaluate((node) => {
      node.scrollIntoView({ behavior: "instant", block: "center" });
    });
    await expect(pairingTarget).toBeInViewport();

    await bringToFront(app.electronApp);
    captureNative("screenshot-pairing.png");
  } finally {
    await app.close();
  }
});

test("bound-thread — thread row + detail with messenger chip", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    // Wait for the app to finish migrating its schema (the replay
    // driver is bootstrapped only after main has initialized).
    await expect(
      app.window.getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      }),
    ).toBeVisible();

    // Seed the binding row.
    seedTelegramBinding({
      stateDbPath: stateDbPathForHomeRoot(app.homeRoot),
      threadId: "thread-recents-hero-primary",
      conversationTitle: "Hunt",
    });

    // Reload the renderer so it re-fetches `thread/list` with the new
    // binding. The main process re-reads sqlite per request so the
    // fresh `messagingBindings` summary lands on the next mount.
    await app.window.reload();
    await expect(
      app.window.getByRole("button", {
        name: /Migrate auth from JWT to session cookies/i,
      }),
    ).toBeVisible();

    // Select the primary thread so the detail pane is in view.
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
    captureNative("screenshot-bound-thread.png");
  } finally {
    await app.close();
  }
});
