import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(specDir, "fixtures/smoke/replay.fixture.json");

/**
 * The resize grip must stay on the sidebar's wall.
 *
 * `.sidebar__resize-handle` is absolutely positioned from `--sidebar-reserve`,
 * is 11px wide and full height, and carries `z-index: 12` while its only
 * visible part is a 1px `::after`. So when the reserve disagrees with the
 * sidebar's painted width, the result is not a misdrawn line — it is an
 * invisible full-height strip lying over the content pane that silently eats
 * every click landing in it.
 *
 * That is what shipped below 1100px. The `@media (max-width: 1100px)` block
 * caps the sidebar grid track at 360px but left `--sidebar-reserve` reading
 * `--sidebar-width` (408px), putting the grip 45px inside the transcript. The
 * Windows E2E lane found it because its runner window is 1024px: two
 * transcript specs could not open a work group, and Playwright named the
 * handle as intercepting the click.
 *
 * Gated here rather than left to that lane for two reasons. The Windows lane
 * is advisory, so it cannot hold the line; and the bug is not Windows-specific
 * at all — any operator with a window under 1100px had it, on every platform.
 *
 * 1024x720 is the Windows runner's own window. The test deliberately does not
 * also drive a wide window: `applyRendererViewport` asserts it got the
 * viewport it asked for, and a width above the runner's screen cannot be
 * granted there. The capped track is the case that was broken anyway.
 */
test("the sidebar resize grip straddles the sidebar wall at a capped width", async () => {
  const app = await launchElectronApp({
    fixturePath,
    windowSize: { width: 1024, height: 720 },
  });

  try {
    await expect(app.window.locator(".sidebar")).toBeVisible();
    await expect(app.window.locator(".sidebar__resize-handle")).toBeAttached();

    const seam = await app.window.evaluate(() => {
      const aside = document.querySelector(".sidebar");
      const grip = document.querySelector(".sidebar__resize-handle");
      if (!aside || !grip) {
        throw new Error("Sidebar or its resize grip is not mounted");
      }
      return {
        wall: aside.getBoundingClientRect().right,
        gripLeft: grip.getBoundingClientRect().left,
        gripRight: grip.getBoundingClientRect().right,
      };
    });

    // Straddling is the contract, not coincidence: the grip is offset back by
    // `--pane-seam-scroll-side` so it covers the border pixel on both sides.
    // Asserting containment rather than an exact offset keeps this honest if
    // that padding is ever retuned, while still failing the moment the grip
    // detaches from the wall — it sat ~45px to the right of it before the fix.
    expect(seam.gripLeft).toBeLessThanOrEqual(seam.wall);
    expect(seam.gripRight).toBeGreaterThanOrEqual(seam.wall);
  } finally {
    await app.close();
  }
});
