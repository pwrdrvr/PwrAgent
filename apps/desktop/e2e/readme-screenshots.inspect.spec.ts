import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { expect, test, type ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

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

function captureNative(outputBasename: string): void {
  mkdirSync(screenshotDir, { recursive: true });
  const outputPath = path.join(screenshotDir, outputBasename);
  execFileSync(captureScript, ["Electron", outputPath], {
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

test("closed-by-default — approval gate", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/approval-pending/replay.fixture.json",
    ),
    windowSize: WINDOW_SIZE,
  });

  try {
    // Drive the UI to the pending-approval state. Beats are lifted from
    // approval-pending.spec.ts so they stay in sync with the fixture.
    await app.window
      .getByRole("button", { name: /Approval pending replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Approval pending replay",
      }),
    ).toBeVisible();
    await app.window
      .getByLabel("Reply")
      .fill("Read /etc/hosts and tell me the first three lines.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await expect(
      app.window.getByRole("button", { name: "Stop" }),
    ).toBeVisible();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "request-approval-1" });

    await expect(
      app.window.getByRole("group", { name: "Pending approval" }),
    ).toBeVisible();
    await expect(
      app.window.getByRole("button", { name: "Approve" }),
    ).toBeVisible();

    await bringToFront(app.electronApp);
    captureNative("screenshot-closed-by-default.png");
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

/**
 * Insert a messaging binding row directly into the tmp profile's
 * state.db so the thread sidebar renders a binding chip on the matching
 * thread row. We could expose `SqliteMessagingStore.upsertBinding` to
 * the harness, but it carries non-trivial sanitization rules and a
 * production-only `MessagingChannelKind` allowlist; for visual capture
 * we only need the columns the renderer reads, and a JSON payload that
 * round-trips through `JSON.parse(payload)` in
 * `findActiveBindingsForThread`.
 *
 * `channel_id` follows `buildChannelId()` in messaging-store-sqlite.ts:
 * `<kind>:<parentId-or-empty>:<id>`. For a Telegram DM the parentId is
 * empty.
 */
function seedTelegramBinding(params: {
  stateDbPath: string;
  threadId: string;
  conversationTitle: string;
}): void {
  const now = 1715431200000;
  const bindingId = "binding-readme-bound-thread";
  const conversation = {
    id: "1234567890",
    kind: "dm" as const,
    title: params.conversationTitle,
  };
  const channel = {
    channel: "telegram" as const,
    conversation,
  };
  const channelIdKey = ["dm", "", conversation.id].join(":");
  const payload = {
    id: bindingId,
    channel,
    backend: "codex",
    threadId: params.threadId,
    authorizedActorIds: [conversation.id],
    createdAt: now,
    updatedAt: now,
  };

  const db = new Database(params.stateDbPath);
  try {
    db.prepare(
      `INSERT OR REPLACE INTO bindings(binding_id, channel_kind, channel_id, thread_id, status, created_at, updated_at, revoked_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bindingId,
      channel.channel,
      channelIdKey,
      params.threadId,
      "active",
      now,
      now,
      null,
      JSON.stringify(payload),
    );
  } finally {
    db.close();
  }
}

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
    const stateDbPath = path.join(
      app.homeRoot,
      ".pwragent/profiles/default/state/state.db",
    );
    seedTelegramBinding({
      stateDbPath,
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
