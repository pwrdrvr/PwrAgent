import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedDiscoveryResearchState, seedHarnessResearchState } from "./fixtures/research-harness-state-seeding";
import { enableResearchFixture } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
test("Discovery status, problems and bounded ancestry retain source authority", async ({ playwright: _playwright }, testInfo) => {
  const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"),
    preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedDiscoveryResearchState(stateDbPathForHomeRoot(homeRoot)); } });
  try {
    await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
    await app.window.getByRole("tab", { name: "Research", exact: true }).click();
    const panel = app.window.getByRole("region", { name: "Research", exact: true });
    await expect(panel.getByLabel("Discovery observation")).toBeVisible();
    await expect(panel.getByText(/PwrAgent has not independently verified/)).toBeVisible();
    // A complete snapshot is not a failure, and it has no deadline of its own.
    await expect(panel.getByText("Snapshot", { exact: true })).toBeVisible();
    await expect(panel.getByText(/^Observed /)).toBeVisible();
    await expect(panel.getByRole("table", { name: "Recorded problems" })).toBeVisible();
    await expect(panel.getByLabel("Recorded candidate ancestry").getByRole("listitem")).toHaveCount(25);
    await panel.getByLabel("Filter discovery nodes").fill("candidate 30");
    await expect(panel.getByLabel("Recorded candidate ancestry").getByText(/parent #14 · round/)).toBeVisible();
    await expect(panel.getByText("passed (source report)")).toBeVisible();
    // The plot and the outline share the recorded node and parent identities.
    await expect(panel.locator('svg [data-node-id="30"][data-parent-id="14"]')).toBeVisible();
    await panel.locator('svg [data-node-id="30"]').click();
    await expect(panel.getByRole("region", { name: "Discovery node 30" })).toBeVisible();
    await testInfo.attach("discovery-ancestry", { body: await app.window.screenshot(), contentType: "image/png" });
  } finally { await app.close(); }
});

for (const theme of ["dark", "light"] as const) {
  test(`Harness provenance and unknown cancellation remain inspectable in ${theme}`, async ({ playwright: _playwright }, testInfo) => {
    const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"), appearance: { theme },
      preLaunchHook: async (homeRoot) => { enableResearchFixture(homeRoot); seedHarnessResearchState(stateDbPathForHomeRoot(homeRoot)); } });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      const outcome = panel.getByRole("group", { name: "Unresolved source outcome" });
      await expect(outcome).toContainText("The bridge did not confirm the stop.");
      await expect(outcome).toContainText("Cancellation was requested, but the bridge did not confirm it.");
      await expect(panel.getByText("Outcome unknown", { exact: true })).toBeVisible();
      await panel.getByText("Source details", { exact: true }).click();
      await expect(panel.getByLabel("Harness provenance")).toContainText("10 records, through #10");
      await expect(panel.getByLabel("Harness provenance")).toContainText("tokens and dollars unknown · no hard spend cap");
      await expect(panel.getByRole("button", { name: /Open worker/ })).toHaveCount(0);
      await testInfo.attach(`harness-outcome-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
      // With no bridge configured, reconciling reports why and restores the unknown outcome; nothing is resent.
      await outcome.getByRole("button", { name: "Reconcile from source" }).click();
      await expect(outcome).toContainText("Reconcile stopped: Configure research.harness");
      await panel.getByRole("tab", { name: "Findings", exact: true }).click();
      await expect(panel.getByText(/^From m1 · #4/)).toBeVisible();
      await expect(panel.getByText("evidence/queue.txt", { exact: true })).toBeVisible();
      await testInfo.attach(`harness-board-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
      await panel.getByRole("tab", { name: /^Review/ }).click();
      await expect(panel.getByText(/Awaiting review/, { exact: false }).last()).toBeVisible();
      await expect(panel.getByText(/It is not formal verification/)).toBeVisible();
      await testInfo.attach(`harness-review-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
      await panel.getByRole("tab", { name: "Activity", exact: true }).click();
      await panel.getByText(/Source coordinator accepted this informal candidate/).scrollIntoViewIfNeeded();
      await expect(panel.getByText(/Source coordinator accepted this informal candidate/)).toBeVisible();
      await testInfo.attach(`harness-activity-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
    } finally { await app.close(); }
  });
}
