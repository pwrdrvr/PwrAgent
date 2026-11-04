import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

test("Settings offers a staged rendering capture without Developer Mode", async () => {
  const testInfo = test.info();
  const app = await launchElectronApp({
    // Hand-authored showcase data, never an operator's profile or transcript.
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/readme-recents-hero/replay.fixture.json"),
  });
  try {
    const page = app.window;
    const openTroubleshooting = async () => {
      await page.getByRole("button", { name: "Open settings", exact: true }).click();
      const nav = page.getByRole("navigation", { name: "Settings sections" });
      await nav.getByRole("button", { name: "Troubleshooting", exact: true }).click();
      return nav;
    };
    let nav = await openTroubleshooting();
    const pane = page.getByRole("region", { name: "Troubleshooting settings", exact: true });
    const developerMode = pane.getByRole("switch", { name: "Developer Mode", exact: true });
    // Development builds default this on; exercise access with it explicitly off.
    if (await developerMode.getAttribute("aria-checked") === "true") {
      await developerMode.click();
    }
    await expect(developerMode).not.toBeChecked();
    const start = pane.getByRole("button", { name: "Capture Rendering (10s)", exact: true });
    await expect(start).toBeEnabled();
    await start.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("rendering-diagnostics-ready.png") });

    await start.click();
    await expect(pane.getByRole("button", { name: "Cancel Rendering Capture", exact: true })).toBeVisible();
    await expect(start).toBeDisabled();
    await nav.getByRole("button", { name: /Exit Settings/i }).click();
    await expect(nav).toBeHidden();
    // This notice arrives only after the real 5s staging + 10s native capture
    // finishes, without reopening Settings or DevTools during the sample.
    await expect(page.getByText("Rendering summary saved", { exact: true })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Dismiss notice", exact: true }).click();
    nav = await openTroubleshooting();
    const copy = pane.getByRole("button", { name: "Copy rendering summary path", exact: true });
    await expect(copy).toBeVisible();
    const summaryPath = await copy.locator("..").locator("code").innerText();
    expect(summaryPath).toMatch(/[/\\]state[/\\]diagnostics[/\\]rendering-[^/\\]+[/\\]summary\.json$/);
    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary.durationMs).toBeGreaterThanOrEqual(10_000);
    expect(summary.samples.length).toBeGreaterThan(0);
    expect(summary.samples.length).toBeLessThanOrEqual(11);
    await expect(start).toBeEnabled();
    await copy.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("rendering-diagnostics-complete.png") });
  } finally {
    await app.close();
  }
});
