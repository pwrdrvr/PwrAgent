import { randomInt } from "node:crypto";
import { expect, test } from "@playwright/test";
import { generatedLayouts, regressionLayouts } from "./scenarios";

test("sidebar lanes fit and every painted PR number stays readable", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => typeof window.checkRendererLayout === "function");

  const seed = Number(process.env.PWRAGENT_LAYOUT_SEED ?? randomInt(-(2 ** 31), 2 ** 31));
  if (!Number.isInteger(seed) || (seed | 0) !== seed) {
    throw new Error("PWRAGENT_LAYOUT_SEED must be a signed 32-bit integer");
  }
  for (const { name, scenario } of [...regressionLayouts, ...generatedLayouts(seed)]) {
    await test.step(name, async () => {
      const result = await page.evaluate((layout) => window.checkRendererLayout(layout), scenario);
      expect(pageErrors).toEqual([]);
      expect(result.lanes, "measured sidebar lanes").toBeGreaterThan(0);
      expect(result.sidebarRows.length, "rendered sidebar thread rows").toBeGreaterThan(0);
      for (const row of result.sidebarRows) {
        if (scenario.density === "minimal") {
          expect(row.titleRollups, `${row.key} has a visible title-line PR rollup`).toBe(1);
        } else {
          expect(row.numberedLeads, `${row.key} has a visible numbered lead PR chip`).toBe(1);
        }
      }
      if (scenario.threads.some((thread) => thread.workerTitle)) {
        expect(result.activityLines, "rendered expanded workers and their activity").toBeGreaterThan(0);
      }
      if (scenario.density !== "minimal" && scenario.threads.some((thread) => thread.stacked)) {
        expect(result.prefixedStackChips, "rendered a repository-prefixed sidebar stack chip").toBeGreaterThan(0);
      }
      expect(result.hasAutoFix, "the Details PR row renders a visible Auto-fix button").toBe(true);
      expect(result.numbers.details, "measured the primary workspace's PR in Details").toBe(1);
      for (const surface of ["prs-panel", "review-picker", "transcript"]) {
        expect(result.numbers[surface] ?? 0, `measured PR numbers in ${surface}`).toBe(scenario.threads[0].prs.length);
      }
      expect(result.findings, `${name} at ${scenario.sidebarWidth}px sidebar / ${scenario.railWidth}px rail`).toEqual([]);
    });
  }
});
