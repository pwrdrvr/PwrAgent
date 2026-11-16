import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedHarnessResearchState } from "./fixtures/research-harness-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
for (const theme of ["dark", "light"] as const) {
  test(`Harness provenance and unknown cancellation remain inspectable in ${theme}`, async ({ playwright: _playwright }, testInfo) => {
    const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"), appearance: { theme },
      preLaunchHook: async (homeRoot) => { seedHarnessResearchState(stateDbPathForHomeRoot(homeRoot)); } });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      await expect(panel.getByLabel("Harness provenance")).toBeVisible();
      await expect(panel.getByText(/source cursor 10/)).toBeVisible();
      await expect(panel.getByText(/token and dollar usage unknown/)).toBeVisible();
      await expect(panel.getByText(/Cancellation acknowledgement was lost/)).toBeVisible();
      await expect(panel.getByRole("button", { name: "Open worker", exact: true })).toHaveCount(0);
      await panel.getByRole("button", { name: "Board", exact: true }).click();
      await expect(panel.getByText(/Source m1 · record 4 · SHA-256/)).toBeVisible();
      await expect(panel.getByText("evidence/queue.txt", { exact: true })).toBeVisible();
      await testInfo.attach(`harness-board-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
      await panel.getByRole("button", { name: "Review", exact: true }).click();
      await expect(panel.getByText(/Awaiting review/, { exact: false }).last()).toBeVisible();
      await expect(panel.getByText(/Formal verification has not been performed/)).toBeVisible();
      await testInfo.attach(`harness-review-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
      await panel.getByRole("button", { name: "Activity", exact: true }).click();
      await expect(panel.getByText(/Source coordinator accepted this informal candidate/)).toBeVisible();
      await testInfo.attach(`harness-activity-${theme}`, { body: await app.window.screenshot(), contentType: "image/png" });
    } finally { await app.close(); }
  });
}
