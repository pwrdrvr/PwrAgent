import { expect, test } from "@playwright/test";
import { generatedLayouts, regressionLayouts } from "./scenarios";

test("sidebar lanes fit and every painted PR number stays readable", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/");
  await page.waitForFunction(() => typeof window.checkRendererLayout === "function");

  for (const { name, scenario } of [...regressionLayouts, ...generatedLayouts()]) {
    await test.step(name, async () => {
      const result = await page.evaluate((layout) => window.checkRendererLayout(layout), scenario);
      expect(pageErrors).toEqual([]);
      expect(result.lanes, "measured sidebar lanes").toBeGreaterThan(0);
      expect(result.rows, "rendered sidebar thread rows").toBeGreaterThan(0);
      if (scenario.threads.some((thread) => thread.workerTitle)) {
        expect(result.activityLines, "rendered expanded workers and their activity").toBeGreaterThan(0);
      }
      if (scenario.density !== "minimal" && scenario.threads.some((thread) => thread.stacked)) {
        expect(result.prefixedStackChips, "rendered a repository-prefixed sidebar stack chip").toBeGreaterThan(0);
      }
      expect(result.hasAutoFix, "the Details PR row renders Auto-fix").toBe(true);
      expect(result.numbers.details, "measured the primary workspace's PR in Details").toBe(1);
      for (const surface of ["prs-panel", "review-picker", "transcript"]) {
        expect(result.numbers[surface] ?? 0, `measured PR numbers in ${surface}`).toBe(scenario.threads[0].prs.length);
      }
      expect(result.findings, `${name} at ${scenario.sidebarWidth}px sidebar / ${scenario.railWidth}px rail`).toEqual([]);
    });
  }
});
