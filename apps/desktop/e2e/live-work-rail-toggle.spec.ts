import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Regression coverage for the dead-chevron bug observed in #497 / fixed in
// #510. These collapses only manifest in a real CSS engine — jsdom honors the
// [hidden] attribute regardless of a conflicting `display: flex` rule — so the
// title and both toggle levels share one Electron lifecycle here.
test("LiveWorkRail title and toggles work in a real CSS engine", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-toggle/replay.fixture.json"
    ),
  });

  try {
    // The rail and the thread context panel are both `complementary`
    // landmarks, so we scope by name. The fixture's cumulative diff
    // adds 3 lines on AGENTS.md and adds 1 / removes 1 on README.md
    // → protocol summary "Edited 2 files, +4, -1".
    const rail = app.window.getByRole("complementary", { name: /Edited 2 files/i });
    const agentsToggle = rail.getByRole("button", { name: /Update AGENTS\.md/i });
    const readmeRow = rail.getByRole("button", { name: /Update README\.md/i });
    const chevron = rail.locator("css=.live-work-rail__collapse");
    // The diff container is intentionally not a landmark and has no
    // accessible name — it's a wrapper that exists only to host the
    // diff content and back the row's `aria-controls`. Class
    // selector is the right tool here.
    const diffBody = rail.locator("css=.live-work-rail__file-diff").first();

    await test.step("render the cumulative summary in the rail title", async () => {
      await app.window
        .getByRole("button", { name: /LiveWorkRail chevron toggle replay/i })
        .first()
        .click();
      await expect(
        app.window.getByRole("heading", {
          level: 2,
          name: "LiveWorkRail chevron toggle replay",
        })
      ).toBeVisible();

      // Kick the turn so turn/diff/updated lands.
      await app.window
        .getByLabel("Reply")
        .fill("Make a small disposable edit to two files.");
      await app.window.getByRole("button", { name: "Send" }).click();
      await app.advance({ stepId: "status-active-1" });
      await app.advance({ stepId: "turn-started-1" });
      await app.advance({ stepId: "turn-diff-updated-1" });

      await expect(rail).toBeVisible();
      await expect(rail.locator("css=.live-work-rail__title")).toContainText(
        "Edited 2 files"
      );
      await expect(agentsToggle).toBeVisible();
      await expect(readmeRow).toBeVisible();
    });

    await test.step("collapse and restore the outer rail body", async () => {
      // Pre-#510, React flipped [hidden], but the body kept rendering because
      // its display:flex rule overrode the user-agent display:none rule.
      await chevron.click();
      await expect(agentsToggle).toBeHidden();
      await expect(readmeRow).toBeHidden();
      await expect(chevron).toHaveAttribute("aria-expanded", "false");

      await chevron.click();
      await expect(agentsToggle).toBeVisible();
      await expect(readmeRow).toBeVisible();
      await expect(chevron).toHaveAttribute("aria-expanded", "true");
    });

    await test.step("expand and collapse a per-file diff body", async () => {
      await expect(agentsToggle).toHaveAttribute("aria-expanded", "false");
      await agentsToggle.click();
      await expect(agentsToggle).toHaveAttribute("aria-expanded", "true");
      await expect(diffBody).toBeVisible();

      await agentsToggle.click();
      await expect(agentsToggle).toHaveAttribute("aria-expanded", "false");
      await expect(diffBody).toBeHidden();
    });
  } finally {
    await app.close();
  }
});
