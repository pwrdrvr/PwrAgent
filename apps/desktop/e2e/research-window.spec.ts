import path from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";
import { seedDiscoveryResearchState, seedHarnessResearchState } from "./fixtures/research-harness-state-seeding";
import { enableResearchFixture, RESEARCH_FIXTURE_OBJECTIVE, seedResearchState } from "./fixtures/research-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));

/** WCAG AA on the whole Research window: it is its own page, so nothing else gates it. */
async function expectAccessible(window: Page, surface: string) {
  const { violations } = await new AxeBuilder({ page: window }).setLegacyMode(true)
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(violations.map((v) => `${surface}: ${v.id} ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  test(`the Research window lists every run by what it needs and inspects items beside the board in ${theme}`, async ({ playwright: _playwright }, testInfo) => {
    const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/research/replay.fixture.json"), appearance: { theme },
      preLaunchHook: async (homeRoot) => {
        enableResearchFixture(homeRoot);
        const db = stateDbPathForHomeRoot(homeRoot);
        seedResearchState(db); seedHarnessResearchState(db); seedDiscoveryResearchState(db);
      } });
    try {
      await app.window.emulateMedia({ reducedMotion: "reduce" });
      await app.window.getByRole("button", { name: /Queue ordering research/ }).first().click();
      await app.window.getByRole("tab", { name: "Research", exact: true }).click();
      const panel = app.window.getByRole("region", { name: "Research", exact: true });
      await expect(panel.getByRole("region", { name: "Research run summary" })).toBeVisible();
      const opened = app.electronApp.waitForEvent("window");
      await panel.getByRole("button", { name: "Open in Research window", exact: true }).click();
      const research = await opened;
      await research.emulateMedia({ reducedMotion: "reduce" });

      // Every run on the profile, across sources, grouped by what it asks of the operator.
      const rail = research.getByRole("navigation", { name: "Research runs" });
      const needsYou = rail.getByRole("region", { name: /^Needs you/ });
      await expect(needsYou.getByRole("button", { name: /Outcome unknown.*Compare invented queue hypotheses with Harness/ })).toBeVisible();
      const retained = rail.getByRole("region", { name: /^Retained/ });
      await expect(retained.getByRole("button", { name: /Snapshot.*Inspect invented discovery ancestry/ })).toBeVisible();
      await expect(retained.getByRole("button", { name: new RegExp(RESEARCH_FIXTURE_OBJECTIVE.slice(0, 30)) })).toBeVisible();
      await expect(rail.getByText(/Queue ordering research/).first()).toBeVisible();

      // The unknown outcome is read and acted on as its coordinating thread.
      await needsYou.getByRole("button", { name: /Outcome unknown/ }).click();
      const main = research.getByRole("main", { name: "Research run" });
      await expect(main.getByRole("group", { name: "Unresolved source outcome" })).toContainText("The bridge did not confirm the stop.");
      await expect(main.getByLabel("Research map")).toBeVisible();
      await main.getByRole("button", { name: /Candidate.*Release retained replies in insertion order/ }).click();
      const inspector = research.getByRole("complementary", { name: "Selected item" });
      await expect(inspector.getByRole("heading", { name: /^Candidate from/ })).toBeFocused();
      await expect(inspector.getByText(/^From m1 · #7/)).toBeVisible();
      // The board keeps its place beside the inspector.
      await expect(main.getByLabel("Research map")).toBeVisible();
      await testInfo.attach(`research-window-${theme}`, { body: await research.screenshot(), contentType: "image/png" });
      await expectAccessible(research, `window with inspector ${theme}`);
      await inspector.getByRole("button", { name: "Close", exact: true }).click();
      await expect(inspector).toHaveCount(0);

      // A discovery snapshot has room for its plot beside the outline.
      await retained.getByRole("button", { name: /Snapshot/ }).click();
      await expect(main.getByText("Snapshot", { exact: true })).toBeVisible();
      await expect(main.locator('svg [data-node-id="30"][data-parent-id="14"]')).toBeVisible();
      await expect(main.getByLabel("Recorded candidate ancestry").getByRole("listitem")).toHaveCount(25);
      await testInfo.attach(`research-window-discovery-${theme}`, { body: await research.screenshot(), contentType: "image/png" });
      await expectAccessible(research, `discovery ${theme}`);

      // The source filter is the owner's, and the pop-out focuses the open window on a run.
      await rail.getByRole("button", { name: "PwrAgent", exact: true }).click();
      await expect(rail.getByRole("button", { name: /Snapshot/ })).toHaveCount(0);
      await expect(rail.getByRole("button", { name: new RegExp(RESEARCH_FIXTURE_OBJECTIVE.slice(0, 30)) })).toBeVisible();
    } finally { await app.close(); }
  });
}
