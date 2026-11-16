import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { RESEARCH_FIXTURE_OBJECTIVE, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

for (const theme of ["dark", "light"] as const) {
  test(`research graph, board and review preserve their evidence in ${theme} mode`, async () => {
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
      appearance: { theme },
      preLaunchHook: async (homeRoot) => { seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
    });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      await expect(panel.getByLabel("Recorded research graph")).toBeVisible();
      await expect(panel.getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open worker", exact: true })).toHaveCount(3);
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-graph-${theme}.png`) });
      await panel.getByRole("button", { name: "Board", exact: true }).click();
      await expect(panel.getByLabel("Shared findings")).toBeVisible();
      await panel.getByRole("button", { name: /^Supports A deterministic/ }).click();
      await expect(panel.getByText(/A deterministic replay reproduces/, { exact: false })).toBeVisible();
      await panel.getByRole("searchbox").fill("");
      await panel.getByRole("button", { name: "Review", exact: true }).click();
      await expect(panel.getByText(/Formal verification has not been performed/)).toBeVisible();
      await expect(panel.getByText("Event ordering · Accepted", { exact: true })).toBeVisible();
      await expect(panel.getByText("Event ordering · Revision requested", { exact: true })).toBeVisible();
      await expect(panel.getByText(/engineering review, not a formal proof/)).toBeVisible();
      await app.window.screenshot({ path: path.resolve(specDir, `../../../.local/research-review-${theme}.png`) });
      await panel.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(panel.getByLabel("Research activity")).toBeVisible();
      await app.window.reload();
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      await expect(app.window.getByRole("region", { name: "Research", exact: true }).getByText(RESEARCH_FIXTURE_OBJECTIVE, { exact: true }).first()).toBeVisible();
    } finally { await app.close(); }
  });
}
