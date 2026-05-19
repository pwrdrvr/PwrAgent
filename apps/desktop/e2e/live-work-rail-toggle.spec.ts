import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

// Regression test for the dead-chevron bug observed in #497 / fixed in
// #510. The collapse only manifests in a real CSS engine — jsdom honors
// the [hidden] attribute via @testing-library/jest-dom's
// `toBeVisible()` regardless of any conflicting `display: flex` rule,
// so this scenario must run in Electron.
test("LiveWorkRail chevron actually collapses the body in a real CSS engine", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-toggle/replay.fixture.json"
    ),
  });

  try {
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

    // The rail and the thread context panel are both `complementary`
    // landmarks, so we scope by name. The fixture's cumulative diff
    // adds 3 lines on AGENTS.md and adds 1 / removes 1 on README.md
    // → protocol summary "Edited 2 files, +4, -1".
    const rail = app.window.getByRole("complementary", { name: /Edited 2 files/i });
    await expect(rail).toBeVisible();

    // File rows from the diff. Their visibility is the witness for
    // whether the rail body is collapsed.
    const agentsRow = rail.getByRole("button", { name: /Update AGENTS\.md/i });
    const readmeRow = rail.getByRole("button", { name: /Update README\.md/i });
    await expect(agentsRow).toBeVisible();
    await expect(readmeRow).toBeVisible();

    // Toggle collapsed. The dead-chevron regression: pre-#510 this
    // click flipped the React state and the [hidden] attribute, but
    // `.live-work-rail__body { display: flex }` silently overrode the
    // UA `[hidden] { display: none }` so the body kept rendering.
    // The collapse button's accessible name is the rail title
    // ("Edited 2 files, ..."); the file-row toggles are named after
    // their files ("Update AGENTS.md", "Update README.md") so this
    // role+name match is unambiguous.
    const chevron = rail.getByRole("button", { name: /^Edited 2 files/ });
    await chevron.click();

    // Body actually disappears now — in real CSS, [hidden] resolves
    // to display:none because we added the explicit override.
    await expect(agentsRow).toBeHidden();
    await expect(readmeRow).toBeHidden();
    await expect(chevron).toHaveAttribute("aria-expanded", "false");

    // Toggle back open.
    await chevron.click();
    await expect(agentsRow).toBeVisible();
    await expect(readmeRow).toBeVisible();
    await expect(chevron).toHaveAttribute("aria-expanded", "true");
  } finally {
    await app.close();
  }
});

test("LiveWorkRail per-file expand toggle hides its diff body in a real CSS engine", async () => {
  // Sibling regression: the same display:flex vs [hidden] interaction
  // would also break the per-file expand chevron once we added the
  // always-mounted diff container (#497 review).
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-toggle/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /LiveWorkRail chevron toggle replay/i })
      .first()
      .click();

    await app.window
      .getByLabel("Reply")
      .fill("Make a small disposable edit to two files.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-diff-updated-1" });

    const rail = app.window.getByRole("complementary", { name: /Edited 2 files/i });
    const agentsToggle = rail.getByRole("button", { name: /Update AGENTS\.md/i });
    await expect(agentsToggle).toHaveAttribute("aria-expanded", "false");

    // Expand: the diff content becomes visible.
    await agentsToggle.click();
    await expect(agentsToggle).toHaveAttribute("aria-expanded", "true");
    // The diff container is intentionally not a landmark and has no
    // accessible name — it's a wrapper that exists only to host the
    // diff content and back the row's `aria-controls`. Class
    // selector is the right tool here.
    const diffBody = rail.locator("css=.live-work-rail__file-diff").first();
    await expect(diffBody).toBeVisible();

    // Collapse: the diff content disappears.
    await agentsToggle.click();
    await expect(agentsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(diffBody).toBeHidden();
  } finally {
    await app.close();
  }
});

test("LiveWorkRail title contains the cumulative summary (merged section heading)", async () => {
  // Locks in the #510 design: the rail title carries the protocol
  // summary directly so there's no second redundant heading line in
  // the body. Easy to regress if anyone re-adds a section h3.
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/live-work-rail-toggle/replay.fixture.json"
    ),
  });

  try {
    await app.window
      .getByRole("button", { name: /LiveWorkRail chevron toggle replay/i })
      .first()
      .click();

    await app.window
      .getByLabel("Reply")
      .fill("Make a small disposable edit to two files.");
    await app.window.getByRole("button", { name: "Send" }).click();
    await app.advance({ stepId: "status-active-1" });
    await app.advance({ stepId: "turn-started-1" });
    await app.advance({ stepId: "turn-diff-updated-1" });

    const rail = app.window.getByRole("complementary", { name: /Edited 2 files/i });
    // `.live-work-rail__title` is the inner <span> that carries the
    // visible title text. It's a presentational element, not a
    // landmark — class selector is intentional.
    const title = rail.locator("css=.live-work-rail__title");
    await expect(title).toContainText("Edited 2 files");

    // No section-level h3 inside the body — the rail title is the
    // single carrier of the summary.
    await expect(rail.getByRole("heading", { level: 3 })).toHaveCount(0);
  } finally {
    await app.close();
  }
});
