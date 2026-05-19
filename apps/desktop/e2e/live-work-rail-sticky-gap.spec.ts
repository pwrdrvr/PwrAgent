import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Asserts the sticky file-toggle pins flush with the rail body's top
// edge (no leftover padding gap). Before this fix, `.live-work-rail__body`
// had `padding: 8px`, so `position: sticky; top: 0` engaged at the
// content-edge top — 8px below the rail header's border-bottom. Visually
// that produced a strip of empty rail-card background between the
// header divider and the sticky toggle when scrolling through a long
// diff.
test("LiveWorkRail sticky file-toggle pins flush with the rail body's top edge", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-sticky-gap/replay.fixture.json"
    ),
    // Force a narrow viewport so the long diff overflows the rail
    // body even on a tall monitor. Rail max-height is min(38vh, 360px)
    // so this guarantees overflow regardless of host display size.
    windowSize: { width: 1280, height: 720 },
  });

  try {
    await app.window
      .getByRole("button", { name: /LiveWorkRail sticky-gap replay/i })
      .first()
      .click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "LiveWorkRail sticky-gap replay",
      })
    ).toBeVisible();

    await app.window
      .getByLabel("Reply")
      .fill("Drop in a long changelog entry to force rail-body scroll.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-diff-updated-1" });

    // Expand the file so its diff body becomes the scrollable region.
    const rail = app.window.getByRole("complementary", { name: /Edited 1 file/i });
    const fileToggle = rail.getByRole("button", { name: /Update CHANGELOG\.md/i });
    await fileToggle.click();
    await expect(fileToggle).toHaveAttribute("aria-expanded", "true");

    // Scroll inside the rail body so the file-toggle engages sticky.
    const railBody = rail.locator("css=.live-work-rail__body");
    await railBody.evaluate((el) => {
      el.scrollTop = 200;
    });

    // After scrolling, the toggle should pin at the same top
    // coordinate as the body's content area's top edge (= the body's
    // border-edge top, since we removed the body's padding-top in
    // the fix). Before the fix the toggle would pin 8px below.
    const toggleTop = await fileToggle.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const bodyTop = await railBody.evaluate(
      (el) => el.getBoundingClientRect().top,
    );

    // Allow 1px slack for sub-pixel rounding.
    expect(Math.abs(toggleTop - bodyTop)).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});

// Inspect-style spec that captures a screenshot for visual review.
// Gated behind the same PWRAGENT_SCREENSHOT_CAPTURE env var the other
// inspect specs use; not run in CI.
test.describe("inspect", () => {
  test.skip(
    !process.env.PWRAGENT_RAIL_INSPECT,
    "Set PWRAGENT_RAIL_INSPECT=1 to capture screenshots locally.",
  );

  test("screenshot the rail with a long diff scrolled into the middle", async () => {
    const app = await launchElectronApp({
      fixturePath: path.resolve(
        specDir,
        "fixtures/live-work-rail-sticky-gap/replay.fixture.json"
      ),
      windowSize: { width: 1280, height: 720 },
    });

    try {
      await app.window
        .getByRole("button", { name: /LiveWorkRail sticky-gap replay/i })
        .first()
        .click();
      await app.window
        .getByLabel("Reply")
        .fill("Drop in a long changelog entry to force rail-body scroll.");
      await app.window.getByRole("button", { name: "Send" }).click();
      await app.advance({ stepId: "status-active-1" });
      await app.advance({ stepId: "turn-started-1" });
      await app.advance({ stepId: "turn-diff-updated-1" });

      const rail = app.window.getByRole("complementary", {
        name: /Edited 1 file/i,
      });
      await rail.getByRole("button", { name: /Update CHANGELOG\.md/i }).click();
      const railBody = rail.locator("css=.live-work-rail__body");
      await railBody.evaluate((el) => {
        el.scrollTop = 200;
      });

      await app.window.screenshot({
        path: path.resolve(
          specDir,
          "../test-results/live-work-rail-sticky-gap.png",
        ),
      });
    } finally {
      await app.close();
    }
  });
});
