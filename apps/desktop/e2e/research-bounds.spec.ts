import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type TestInfo } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { LIVE_RESEARCH_OBJECTIVE, enableResearchFixture, readResearchOwnerIdentity, seedLiveResearchRun, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
/** Saved under `.local/` for a local run and attached to the report, so a CI run's artifact holds it too. */
async function capture(testInfo: TestInfo, name: string, target: { screenshot: (options: { path: string }) => Promise<Buffer> }): Promise<void> {
  const body = await target.screenshot({ path: path.resolve(specDir, `../../../.local/${name}.png`) });
  await testInfo.attach(name, { body, contentType: "image/png" });
}

for (const theme of ["dark", "light"] as const) {
  test(`a running run's card shows the worker limits set and changes its bounds in ${theme} mode`, async ({ playwright: _playwright }, testInfo) => {
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
      appearance: { theme },
      preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
    });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      seedLiveResearchRun(stateDbPathForHomeRoot(app.homeRoot), readResearchOwnerIdentity(app.homeRoot, app.electronApp.process().pid!), Date.now(), { turnMinutes: 45, totalWorkerMinutes: 600 });
      await app.window.reload();
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      const summary = panel.getByRole("region", { name: "Research run summary" });
      await expect(summary).toContainText(LIVE_RESEARCH_OBJECTIVE);
      const limits = summary.getByLabel("Worker limits");
      await expect(limits).toContainText("Each worker");
      await expect(limits).toContainText("45 min");
      await expect(limits).toContainText(/of 10 h/);
      // The worker its limit stopped says why, on the Map.
      await expect(panel.getByText(/Stopped at the per-worker time limit of 45 minutes/)).toBeVisible();
      await capture(testInfo, `research-bounds-card-${theme}`, app.window);

      await summary.getByRole("button", { name: "Change bounds…", exact: true }).click();
      const editor = summary.getByRole("form", { name: "Change the run's bounds" });
      await expect(editor.getByLabel("Workers at once")).toHaveValue("4");
      await editor.getByLabel("Workers at once").fill("6");
      const time = editor.getByRole("group", { name: /^Time limit, from the start/ });
      await time.getByLabel("Length").fill("60");
      await expect(editor).toContainText(/The run ends at /);
      await capture(testInfo, `research-bounds-editor-${theme}`, app.window);
      await editor.getByRole("button", { name: "Save bounds", exact: true }).click();
      await expect(summary.getByRole("form", { name: "Change the run's bounds" })).toHaveCount(0);
      await expect(summary.getByText(/ of 6$/)).toBeVisible();
      await expect(panel.getByRole("status")).toContainText("Bounds saved.");
      await expect(summary.getByText("Running", { exact: true })).toBeVisible();
    } finally { await app.close(); }
  });
}

test("the start form offers a per-worker time limit and total worker time, both off until set", async ({ playwright: _playwright }, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    appearance: { theme: "dark" },
    preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedResearchState(stateDbPathForHomeRoot(homeRoot)); },
  });
  try {
    await app.window.emulateMedia({ reducedMotion: "reduce" });
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    const panel = app.window.getByRole("region", { name: "Research", exact: true });
    await panel.getByRole("button", { name: "New run", exact: true }).click();
    const form = panel.getByRole("form", { name: "New research run" });
    await form.getByLabel("Objective").fill("Find every place the queue can reorder a terminal event, and a fix for each");
    for (const name of ["Time limit", "Per-worker time limit", "Total worker time"]) {
      await expect(form.getByRole("group", { name, exact: true }).getByRole("button", { name: "No limit" })).toHaveAttribute("aria-pressed", "true");
    }
    const turn = form.getByRole("group", { name: "Per-worker time limit", exact: true });
    await turn.getByRole("button", { name: "Set a limit" }).click();
    await turn.getByLabel("Length").fill("45");
    await turn.getByRole("combobox", { name: "Unit" }).click();
    await app.window.getByRole("option", { name: "Minutes", exact: true }).click();
    await expect(form).toContainText("A worker whose turn runs past 45 min is stopped; the run continues.");
    await capture(testInfo, "research-bounds-form-dark", form);
  } finally { await app.close(); }
});
