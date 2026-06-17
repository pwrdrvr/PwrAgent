import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Asserts the sticky edit-group header pins flush with the rail body's top
// edge, and the sticky file-toggle pins flush beneath that group header (no
// leftover padding gap). Before #510, `.live-work-rail__body` had
// `padding: 8px`, so sticky children engaged 8px below the rail header's
// border-bottom and left a strip of empty rail-card background while
// scrolling through a long diff.
test("LiveWorkRail sticky edit header and file-toggle pin without a gap", async () => {
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

    // After scrolling, the edit-group header should pin at the rail body's
    // top edge, and the file toggle should pin flush beneath that header. The
    // no-gap assertion now targets the header->row seam because the transcript
    // rail keeps the edit-group header even for a single group.
    const groupHeader = rail.locator("css=.edited-file-groups__group-header");
    const toggleTop = await fileToggle.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const bodyTop = await railBody.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const headerTop = await groupHeader.evaluate(
      (el) => el.getBoundingClientRect().top,
    );
    const headerBottom = await groupHeader.evaluate(
      (el) => el.getBoundingClientRect().bottom,
    );

    // Allow 1px slack for sub-pixel rounding.
    expect(Math.abs(headerTop - bodyTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(toggleTop - headerBottom)).toBeLessThanOrEqual(1);
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
