import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  findLatestPairingEntryId,
  markPairingObserved,
  seedActivityEntries,
  seedTelegramBinding,
  seedTelegramEnabledConfig,
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

/**
 * Synthetic personas used across the screenshot captures. Everything
 * here is deliberately invented — no real Telegram peer IDs, no real
 * Slack workspace IDs, no real human names. The numeric and opaque
 * IDs follow each platform's format closely enough to look plausible
 * but include obvious tells:
 *   - Telegram peer ids use the 555-prefixed phone-number-style block
 *     reserved for fiction.
 *   - Telegram supergroup ids preserve the `-100xxx` format but use
 *     a synthetic body.
 *   - Slack workspace/channel ids embed "FAKE" so screenshot viewers
 *     can tell at a glance that nothing here points at a real
 *     workspace.
 * Reusing these constants across tests keeps the captures coherent —
 * the "bound thread" chip and the "Inbound from ..." activity rows
 * reference the same fake user.
 */
const PERSONA_OWNER = {
  displayName: "Riley Chen",
  username: "rileychen",
  telegramPeerId: "5550199999",
} as const;

const PERSONA_REJECTED = {
  displayName: "Casey Wong",
  slackUserId: "U0FAKE001",
  slackChannelId: "C0FAKE002",
  slackChannelTitle: "design-chat",
} as const;

const SYNTHETIC_TELEGRAM_SUPERGROUP_ID = "-1009990000001";
const SYNTHETIC_TELEGRAM_TOPIC_ID_PRIMARY = "42";
const SYNTHETIC_TELEGRAM_TOPIC_ID_SECONDARY = "108";

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
      conversationTitle: PERSONA_OWNER.displayName.split(" ")[0],
      conversationId: PERSONA_OWNER.telegramPeerId,
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
        conversationId: SYNTHETIC_TELEGRAM_TOPIC_ID_PRIMARY,
        actorId: PERSONA_OWNER.telegramPeerId,
        actorDisplayName: PERSONA_OWNER.displayName,
        summary: `Inbound from ${PERSONA_OWNER.displayName}`,
        createdAt: now - 19 * hour,
        payload: {
          conversationKind: "topic",
          conversationParentId: SYNTHETIC_TELEGRAM_SUPERGROUP_ID,
          conversationBucketId: SYNTHETIC_TELEGRAM_SUPERGROUP_ID,
        },
      },
      {
        platform: "telegram",
        kind: "inbound-routed",
        threadId: "thread-recents-hero-primary",
        bindingId,
        conversationId: SYNTHETIC_TELEGRAM_TOPIC_ID_SECONDARY,
        actorId: PERSONA_OWNER.telegramPeerId,
        actorDisplayName: PERSONA_OWNER.displayName,
        summary: `Inbound from ${PERSONA_OWNER.displayName}`,
        createdAt: now - 20 * hour,
        payload: {
          conversationKind: "topic",
          conversationParentId: SYNTHETIC_TELEGRAM_SUPERGROUP_ID,
          conversationBucketId: SYNTHETIC_TELEGRAM_SUPERGROUP_ID,
        },
      },
      {
        platform: "slack",
        kind: "inbound-rejected",
        conversationId: PERSONA_REJECTED.slackChannelId,
        conversationTitle: PERSONA_REJECTED.slackChannelTitle,
        actorId: PERSONA_REJECTED.slackUserId,
        actorDisplayName: PERSONA_REJECTED.displayName,
        summary: `Rejected inbound from ${PERSONA_REJECTED.displayName}`,
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
      activityWindow
        .getByText(new RegExp(`Inbound from ${PERSONA_OWNER.displayName}`))
        .first(),
    ).toBeVisible();
    await expect(
      activityWindow.getByText(
        new RegExp(`Rejected inbound from ${PERSONA_REJECTED.displayName}`),
      ),
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

/**
 * Drive the renderer from the main shell into Settings → Messaging
 * with the Telegram Pairing field scrolled into the center of the
 * viewport. Used for every frame of the pairing GIF so each frame
 * frames the same surface area.
 */
async function navigateToTelegramPairing(
  app: Awaited<ReturnType<typeof launchElectronApp>>,
): Promise<void> {
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

  const pairingTarget = app.window
    .getByRole("radiogroup", { name: /^Telegram pairing target$/i })
    .first();
  await pairingTarget.waitFor({ state: "visible" });
  await pairingTarget.evaluate((node) => {
    node.scrollIntoView({ behavior: "instant", block: "center" });
  });
  await expect(pairingTarget).toBeInViewport();
}

/**
 * Stitch a sequence of PNG frames into a looping GIF with a numbered
 * step-indicator overlay (so viewers can tell which frame of the
 * sequence they're on). The actual stitcher + overlay renderer live
 * in sibling `scripts/` files so they can be reused for any future
 * demo GIF — this function is a thin wrapper that runs the script
 * via `pnpm exec tsx`.
 *
 * We invoke through `pnpm exec` (rather than reaching directly into
 * `node_modules/.bin/tsx`) so the resolution survives changes to
 * pnpm's hoisting layout. Cost is one extra process spawn per stitch,
 * which is rounding error against the GIF-encode time.
 */
function stitchGif(params: {
  framePaths: string[];
  outputPath: string;
  /** Milliseconds per frame; default 1500. */
  frameDurationMs?: number;
}): void {
  const desktopPackageDir = path.resolve(specDir, "..");
  const stitcher = path.join(
    desktopPackageDir,
    "scripts/stitch-demo-gif.ts",
  );
  execFileSync(
    "pnpm",
    [
      "exec",
      "tsx",
      stitcher,
      "--output",
      params.outputPath,
      "--frame-duration-ms",
      String(params.frameDurationMs ?? 1500),
      ...params.framePaths,
    ],
    { stdio: "inherit", cwd: desktopPackageDir },
  );
}

test("pairing — Generate → observe → approve sequence (animated GIF)", async () => {
  test.setTimeout(180_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/readme-recents-hero/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
    // Pre-launch hook seeds a config.toml with `[messaging.telegram]
    // enabled = true` so the renderer's "Telegram → Enabled" toggle
    // reads as on and the Pairing field's Generate button isn't
    // disabled. No bot token required — `generatePairingToken` is a
    // local HMAC + sqlite write (see MessagingRuntime.generatePairingToken).
    preLaunchHook: seedTelegramEnabledConfig,
  });

  const stateDbPath = stateDbPathForHomeRoot(app.homeRoot);
  // Frame paths land in docs/assets/screenshots/ alongside the final
  // GIF — useful for archival and for re-stitching with different
  // frame timings without rerunning the whole test.
  const frame1Path = path.join(screenshotDir, "screenshot-pairing-frame-1.png");
  const frame2Path = path.join(screenshotDir, "screenshot-pairing-frame-2.png");
  const frame3Path = path.join(screenshotDir, "screenshot-pairing-frame-3.png");
  const gifPath = path.join(screenshotDir, "screenshot-pairing.gif");
  mkdirSync(screenshotDir, { recursive: true });

  try {
    // ──────── FRAME 1: Generate clicked, pair code visible ────────
    await navigateToTelegramPairing(app);

    // The Telegram section's Generate button. Two `Generate` buttons
    // exist in the panel (one per platform pairing field that's in
    // view); scope to the Telegram section by anchoring on the
    // Telegram pairing target radiogroup's parent.
    const telegramGenerateButton = app.window
      .locator(".settings-pairing")
      .filter({
        has: app.window.getByRole("radiogroup", {
          name: /^Telegram pairing target$/i,
        }),
      })
      .getByRole("button", { name: /^Generate$/ });
    await telegramGenerateButton.click();

    // Wait for the pair code to render. The renderer renders the
    // generated token inside a `<code>` element under the Pairing
    // field's `.settings-pairing__message` row.
    const pairCode = app.window
      .locator(".settings-pairing__message code")
      .first();
    await expect(pairCode).toBeVisible({ timeout: 10_000 });

    await bringToFront(app.electronApp);
    execFileSync(captureScript, ["Electron", frame1Path], { stdio: "inherit" });

    // ──────── FRAME 2: observed entry, approval prompt visible ────────
    // Look up the row the renderer just generated and mutate it to
    // status="observed" with a populated observedActor. The renderer
    // doesn't re-poll on direct sqlite mutation, so reload the window
    // to remount PairingTokenField, which calls `refresh()` on mount.
    const entryId = findLatestPairingEntryId(stateDbPath, "telegram");
    if (!entryId) {
      throw new Error(
        "no telegram pairing entry found after Generate click — runtime may not have written to sqlite",
      );
    }
    markPairingObserved(stateDbPath, entryId, {
      observedActor: {
        id: PERSONA_OWNER.telegramPeerId,
        username: PERSONA_OWNER.username,
        displayName: PERSONA_OWNER.displayName,
      },
      observedChat: {
        id: PERSONA_OWNER.telegramPeerId,
        kind: "dm",
        title: PERSONA_OWNER.displayName,
      },
    });

    await app.window.reload();
    await navigateToTelegramPairing(app);

    // The approval prompt — observedEntries are filtered by
    // status === "observed" in PairingTokenField. The Approve button
    // appears next to the row.
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
    execFileSync(captureScript, ["Electron", frame2Path], { stdio: "inherit" });

    // ──────── FRAME 3: approved — user lands in Authorized Users ────────
    // Click Approve. This triggers `approveMessagingPairing` IPC,
    // which patches config.toml to add the user to
    // `[messaging.telegram] authorized_users`, marks the pairing
    // entry consumed, and refreshes the settings snapshot. The
    // approval prompt vanishes (status no longer "observed") and the
    // user appears in the Authorized User IDs field below.
    await telegramApproveButton.click();

    // Wait for the Authorized User IDs row to display the user id
    // input populated with our seeded user. The MessagingSettings
    // renders a row per authorized user with the numeric peer id in
    // a text input and the display name beside it.
    await expect(
      app.window
        .locator(`input[value="${PERSONA_OWNER.telegramPeerId}"]`)
        .first(),
    ).toBeVisible({ timeout: 10_000 });

    // Re-scroll so the Pairing field stays at center (the Authorized
    // User IDs field is just below it).
    await app.window
      .getByRole("radiogroup", { name: /^Telegram pairing target$/i })
      .first()
      .evaluate((node) => {
        node.scrollIntoView({ behavior: "instant", block: "center" });
      });

    await bringToFront(app.electronApp);
    execFileSync(captureScript, ["Electron", frame3Path], { stdio: "inherit" });

    // ──────── Stitch into a looping GIF ────────
    stitchGif({
      framePaths: [frame1Path, frame2Path, frame3Path],
      outputPath: gifPath,
    });
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
      conversationTitle: PERSONA_OWNER.displayName.split(" ")[0],
      conversationId: PERSONA_OWNER.telegramPeerId,
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
