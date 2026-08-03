// macOS/ARM64 visual-regression coverage for stable replay-backed desktop
// surfaces. These are locator-scoped on purpose: BrowserWindow chrome and OS
// shadows belong to native screenshot documentation, not renderer contracts.
//
// The reference PNG files are generated on the matching Tart VM runner and
// stored in Git LFS. Update them from the off-desktop VM lab, never from a
// Linux host or a developer's active desktop:
//
//   ~/pwragent-mac-vm/run-e2e.sh --local /path/to/PwrAgent \
//     e2e/visual-regression.spec.ts --update-snapshots

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_WINDOW_SIZE = { width: 1440, height: 900 };
const VISUAL_CLOCK_TIME = new Date("2026-08-02T12:00:00.000Z");
const VISUAL_APP_VERSION = "1.2.3-beta.1";

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test.describe("visual regression", () => {
  // Chromium raster output is platform-specific. The PwrDrvr Tart runners are
  // macOS/ARM64, so that is the one authoritative golden environment for now.
  test.skip(
    process.platform !== "darwin" || process.arch !== "arm64",
    "visual goldens are generated and compared on macOS/ARM64 only",
  );

  test.setTimeout(120_000);

  test("renders a replayed todo thread in the desktop shell", async () => {
    const app = await launchElectronApp({
      fixturePath: path.resolve(
        specDir,
        "fixtures/codex-todo-list/replay.fixture.json",
      ),
      env: { PWRAGENT_E2E_APP_VERSION: VISUAL_APP_VERSION },
      windowSize: VISUAL_WINDOW_SIZE,
    });

    try {
      await app.window.clock.setFixedTime(VISUAL_CLOCK_TIME);
      await app.window
        .getByRole("button", { name: /Add AGENTS docs for media VCL/i })
        .first()
        .click();
      await expect(
        app.window.getByRole("heading", {
          level: 2,
          name: "Add AGENTS docs for media VCL",
        }),
      ).toBeVisible();
      await expect(
        app.window.getByText(
          /Existing Codex threads cannot be converted/,
        ),
      ).toBeVisible();
      await expect.poll(async () =>
        await app.window.evaluate(async () => {
          const bridge = globalThis as typeof globalThis & {
            pwragent?: {
              readAppMetadata?: () => Promise<{ applicationVersion: string }>;
            };
          };
          return (await bridge.pwragent?.readAppMetadata?.())?.applicationVersion;
        })
      ).toBe(VISUAL_APP_VERSION);

      const shell = app.window.locator(".app-shell");
      await expect(shell).toBeVisible();
      await waitForFonts(app.window);
      await expect(shell).toHaveScreenshot("todo-thread-shell.png", {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
    } finally {
      await app.close();
    }
  });

  test("renders a pending approval request", async () => {
    const app = await launchElectronApp({
      fixturePath: path.resolve(
        specDir,
        "fixtures/approval-pending/replay.fixture.json",
      ),
      env: { PWRAGENT_E2E_APP_VERSION: VISUAL_APP_VERSION },
      windowSize: VISUAL_WINDOW_SIZE,
    });

    try {
      await app.window.clock.setFixedTime(VISUAL_CLOCK_TIME);
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

      await app.window.getByLabel("Reply").fill("Run the proposed validation.");
      await app.window.getByRole("button", { name: "Send" }).click();
      await app.advance({ stepId: "status-active-1" });
      await app.advance({ stepId: "turn-started-1" });
      await app.advance({ stepId: "request-approval-1" });

      const approval = app.window.getByRole("group", { name: "Pending approval" });
      await expect(approval).toBeVisible();
      await waitForFonts(app.window);
      await expect(approval).toHaveScreenshot("pending-approval.png", {
        animations: "disabled",
        caret: "hide",
        scale: "css",
      });
    } finally {
      await app.close();
    }
  });
});
