// macOS/ARM64 visual-regression coverage for stable replay-backed desktop
// surfaces. These are locator-scoped on purpose: BrowserWindow chrome and OS
// shadows belong to native screenshot documentation, not renderer contracts.
//
// The reference PNG files are generated on the matching Tart VM runner and
// stored in Git LFS. Update them from the off-desktop VM lab, never from a
// Linux host or a developer's active desktop:
//
//   ~/pwrdrvr/PwrSuiteLab/macos-tart/run-e2e.sh --confirm-live-run \
//     --workload pwragent --local /path/to/PwrAgent \
//     e2e/visual-regression.spec.ts --update-snapshots
//
// VISUAL_MAX_DIFF_PIXELS exists because the lab guest and the CI macOS runner
// no longer rasterize identically. A golden regenerated on the lab lands 8
// pixels away from what CI renders — scattered singletons in the sidebar, the
// transcript header, and one at the far right edge, with no layout difference
// and no cluster. Both the CI run and its retry produced the same 8, so it is
// a deterministic per-machine antialiasing difference, not run-to-run flake.
//
// 20 is deliberately just above that noise floor and far below anything real:
// the icon-only lens switch moved 7368 pixels and adding a fourth lens tab
// moved 659. Treat a diff between 20 and a few hundred as a genuine finding to
// investigate, not a reason to raise this number. If the floor climbs past 20,
// the lab guest has drifted further from CI and that is the bug to fix — the
// lab is supposed to be the authoritative golden environment.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const VISUAL_WINDOW_SIZE = { width: 1440, height: 900 };
/** See the lab-vs-CI antialiasing note in the file header before changing. */
const VISUAL_MAX_DIFF_PIXELS = 20;
const VISUAL_CLOCK_TIME = new Date("2026-08-02T12:00:00.000Z");
const VISUAL_APP_VERSION = "1.2.3-beta.1";
const VISUAL_INITIAL_LOAD_DURATION = "3 ms";

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
      const initialLoadDuration = app.window
        .getByText("Initial load", { exact: true })
        .locator("xpath=following-sibling::dd");
      await expect(initialLoadDuration).toBeVisible();
      // The real backend read is intentionally measured, so its exact value
      // varies by a millisecond or two between otherwise identical runs.
      // Normalize only that volatile text while retaining the row and layout
      // in the visual contract.
      await initialLoadDuration.evaluate((element, duration) => {
        element.textContent = duration;
      }, VISUAL_INITIAL_LOAD_DURATION);
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
        maxDiffPixels: VISUAL_MAX_DIFF_PIXELS,
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
        maxDiffPixels: VISUAL_MAX_DIFF_PIXELS,
        scale: "css",
      });
    } finally {
      await app.close();
    }
  });
});
