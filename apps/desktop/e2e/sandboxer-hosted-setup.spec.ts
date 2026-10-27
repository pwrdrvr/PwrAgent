import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

test("fresh Sandboxer setup offers hosted sign-in without a local CLI", async ({}, testInfo) => {
  const app = await launchElectronApp({
    fixturePath: path.join(import.meta.dirname, "fixtures/smoke/replay.fixture.json"),
  });
  try {
    await app.window.getByRole("button", { name: "Open settings", exact: true }).click();
    await app.window.getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Plugins", exact: true }).click();
    const row = app.window.locator("article.settings-mcp-row").filter({
      has: app.window.locator(".settings-mcp-row__name", { hasText: /^Sandboxer$/ }),
    });
    await expect(row.getByRole("button", { name: "Connect Sandboxer", exact: true })).toBeVisible();
    await expect(row).toContainText("separate from your PwrAgent and coding agent accounts");
    await expect(row.getByRole("button", { name: "Get Sandboxer CLI", exact: true })).toHaveCount(0);
    await expect(row.getByRole("button", { name: "Copy setup command", exact: true })).toHaveCount(0);
    await expect(row.getByRole("switch", { name: "Offer Sandboxer to threads", exact: true })).toHaveCount(0);
    const method = row.getByRole("combobox", { name: "Sandboxer connection method", exact: true });
    await expect(method).toHaveAttribute("data-value", "hosted");
    await method.click();
    await expect(app.window.getByRole("option", { name: "Hosted · browser sign-in", exact: true })).toBeVisible();
    await expect(app.window.getByRole("option", { name: "Local CLI · existing login or API key", exact: true })).toBeVisible();
    await method.press("Escape");
    // Only the isolated fixture row; no OAuth flow, operator account or private threads.
    await row.screenshot({ path: testInfo.outputPath("sandboxer-hosted-setup.png") });
  } finally {
    await app.close();
  }
});
