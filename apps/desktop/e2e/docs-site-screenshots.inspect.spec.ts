import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import { resolveScreenshotAppearance } from "./fixtures/screenshot-appearance";
import { seedAllMessagingProvidersEnabledConfig } from "./fixtures/docs-site-state-seeding";
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

// Resolved once per spec module from PWRAGENT_SCREENSHOT_THEME /
// PWRAGENT_SCREENSHOT_DENSITY env vars (both optional). Defaults match
// the production E2E defaults (theme=dark, density=mission-control) so
// the committed PNGs stay pixel-stable when neither variable is set.
// See `fixtures/screenshot-appearance.ts` for the env-var contract.
const SCREENSHOT_APPEARANCE = resolveScreenshotAppearance();

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
    appearance: SCREENSHOT_APPEARANCE,
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
    appearance: SCREENSHOT_APPEARANCE,
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
    appearance: SCREENSHOT_APPEARANCE,
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

test("settings-profiles — Settings → Profiles panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
    fixturePath: path.resolve(specDir, "fixtures/smoke/replay.fixture.json"),
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
    await openSettingsSection(app.window, {
      navLabel: "Profiles",
      regionLabel: "Profile settings",
    });

    await bringToFront(app.electronApp);
    captureNative("settings-profiles.png");
  } finally {
    await app.close();
  }
});

test("settings-general — Settings → General panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    captureNative("settings-general.png");
  } finally {
    await app.close();
  }
});

test("settings-experimental — Settings → Experimental panel", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    captureNative("settings-experimental.png");
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
    appearance: SCREENSHOT_APPEARANCE,
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

// ────────────────────── Messaging — Pairing flow (3 frames) ──────────────────────

// Sanitized persona used for the pairing approval / authorized-user
// row. Matches the README pairing-GIF persona so the docs-site +
// README screenshots tell a coherent fictional story (no real IDs).
const PAIRING_PERSONA = {
  displayName: "Riley Chen",
  username: "rileychen",
  telegramPeerId: "5550199999",
} as const;

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
    .getByRole("button", { name: "Messaging" });
  await messagingNav.click();
  await expect(
    page.getByRole("region", { name: "Messaging settings" }),
  ).toBeVisible();

  const pairingTarget = page
    .getByRole("radiogroup", { name: /^Telegram pairing target$/i })
    .first();
  await pairingTarget.waitFor({ state: "visible" });
  await pairingTarget.evaluate((node) => {
    node.scrollIntoView({ behavior: "instant", block: "center" });
  });
  await expect(pairingTarget).toBeInViewport();
}

test("messaging-pairing — frame 1: pairing token generated", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    const pairCode = app.window
      .locator(".settings-pairing__message code")
      .first();
    await expect(pairCode).toBeVisible({ timeout: 10_000 });

    await bringToFront(app.electronApp);
    captureNative("messaging-pairing-frame-1.png");
  } finally {
    await app.close();
  }
});

test("messaging-pairing — frame 2: observed, approval prompt visible", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    captureNative("messaging-pairing-frame-2.png");
  } finally {
    await app.close();
  }
});

test("messaging-pairing — frame 3: approved, user in authorized list", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    captureNative("messaging-pairing-frame-3.png");
  } finally {
    await app.close();
  }
});

// ────────────────────── Messaging — Activity surface (troubleshooting) ──────────────────────

test("messaging-activity-blocked — Messaging Activity showing rejected inbound", async () => {
  test.setTimeout(120_000);

  const app = await launchElectronApp({
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
    const hour = 60 * minute;
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

    mkdirSync(screenshotDir, { recursive: true });
    execFileSync(
      captureScript,
      [
        "Electron",
        path.join(screenshotDir, "messaging-activity-blocked.png"),
        "--title=Messaging Activity",
      ],
      { stdio: "inherit" },
    );
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
  const app = await launchElectronApp({
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

    await bringToFront(app.electronApp);
    captureNative("desktop-recents.png");
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
  const app = await launchElectronApp({
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

    await bringToFront(app.electronApp);
    captureNative("desktop-skills-autocomplete.png");
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

  const app = await launchElectronApp({
    fixturePath,
    windowSize: WINDOW_SIZE,
    appearance: SCREENSHOT_APPEARANCE,
  });

  try {
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
    await expect(app.window.getByLabel("Queued message")).toContainText(
      "Review changes against main",
    );

    // Stack a second queued follow-up so the screenshot shows the
    // FIFO-deep-queue capability, not just a single chip.
    await textbox.fill("now squash and push --force-with-lease");
    await app.window.getByRole("button", { name: "Queue" }).click();
    await expect(
      app.window
        .getByLabel("Queued message")
        .filter({ hasText: "squash and push" }),
    ).toBeVisible();

    await bringToFront(app.electronApp);
    captureNative("desktop-queued-turns.png");
  } finally {
    await app.close();
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
