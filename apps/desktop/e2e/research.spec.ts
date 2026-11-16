import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { RESEARCH_FIXTURE_OBJECTIVE, seedResearchState, enableResearchFixture } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("research stays hidden until the experiment is enabled and hides again when disabled", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => { seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
  });
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await expect(app.window.getByRole("tab", { name: "Research", exact: true })).toHaveCount(0);
    await app.window.getByRole("button", { name: "Open settings" }).click();
    const nav = app.window.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    const toggle = app.window.getByRole("switch", { name: "Enable research runs", exact: true });
    await expect(toggle).not.toBeChecked();
    await app.window.screenshot({ path: path.resolve(specDir, "../../../.local/research-experiment-off.png") });
    await toggle.click();
    await expect(toggle).toBeChecked();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    await expect(app.window.getByRole("region", { name: "Research", exact: true }).getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
    await app.window.getByRole("button", { name: "Open settings" }).click();
    await nav.getByRole("button", { name: "Experimental", exact: true }).click();
    await app.window.getByRole("switch", { name: "Enable research runs", exact: true }).click();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await expect(app.window.getByRole("tab", { name: "Research", exact: true })).toHaveCount(0);
    await expect(app.window.getByRole("region", { name: "Research", exact: true })).toHaveCount(0);
  } finally { await app.close(); }
});

for (const theme of ["dark", "light"] as const) {
  test(`research graph, board and review preserve their evidence in ${theme} mode`, async () => {
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
      appearance: { theme },
      preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
    });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      await expect(panel.getByLabel("Recorded research graph")).toBeVisible();
      await expect(panel.getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open worker", exact: true })).toHaveCount(4);
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-graph-${theme}.png`) });
      await panel.getByRole("button", { name: "Board", exact: true }).click();
      await expect(panel.getByLabel("Shared findings")).toBeVisible();
      await panel.getByRole("article").filter({ hasText: "Persisted insertion order agrees" }).getByRole("button", { name: /^Supports A deterministic/ }).click();
      await expect(panel.getByText(/A deterministic replay reproduces/, { exact: false })).toBeVisible();
      await panel.getByRole("searchbox").fill("");
      await panel.getByRole("button", { name: "Review", exact: true }).click();
      await expect(panel.getByText(/Formal verification has not been performed/)).toBeVisible();
      await expect(panel.getByText("Event ordering · Accepted", { exact: true })).toBeVisible();
      await expect(panel.getByText("Event ordering · Revision requested", { exact: true })).toBeVisible();
      await expect(panel.getByText(/engineering review, not a formal proof/)).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-review-${theme}.png`) });
      await panel.getByRole("button", { name: "Items", exact: true }).click();
      await expect(panel.getByLabel("Research items")).toBeVisible();
      await panel.getByLabel("Search items", { exact: true }).fill("deterministic replay");
      await panel.getByLabel("Item type", { exact: true }).selectOption("finding");
      await panel.getByLabel("Work state", { exact: true }).selectOption("completed");
      await panel.getByRole("button", { name: "Search", exact: true }).click();
      await expect(panel.getByText("1 matching items · showing 1", { exact: true })).toBeVisible();
      await panel.getByRole("button", { name: /^Finding · Completed A deterministic replay/ }).click();
      const detail = panel.getByRole("article", { name: "Selected research item" });
      await expect(detail.getByText("ordering", { exact: true })).toBeVisible();
      await expect(detail.getByRole("button", { name: "Open assigned thread", exact: true })).toBeVisible();
      await expect(detail.getByText(/focused child reproduced/)).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-items-${theme}.png`) });
      await panel.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(panel.getByLabel("Research activity")).toBeVisible();
      await app.window.reload();
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      await expect(app.window.getByRole("region", { name: "Research", exact: true }).getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
    } finally { await app.close(); }
  });
}
