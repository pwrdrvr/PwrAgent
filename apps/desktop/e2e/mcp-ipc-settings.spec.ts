import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

test("MCP server URL form accepts local IPC syntax", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/readme-recents-hero/replay.fixture.json"),
  });
  try {
    const page = app.window;
    await page.getByRole("button", { name: "Open settings", exact: true }).click();
    const nav = page.getByRole("navigation", { name: "Settings sections" });
    await nav.getByRole("button", { name: "Plugins", exact: true }).click();
    const add = page.getByRole("button", { name: "Add MCP server", exact: true });
    if (await add.isVisible()) await add.click();
    await expect(page.getByText("HTTP over network or local IPC", { exact: true })).toBeVisible();
    const url = page.getByPlaceholder("https://mcp.example.com/mcp");
    await url.fill("unix:///run/user/1000/example-mcp/server.sock#/mcp");
    await expect(page.getByRole("button", { name: "Check", exact: true })).toBeEnabled();
    await url.scrollIntoViewIfNeeded();
    await page.locator(".settings-mcp-create").screenshot({ path: test.info().outputPath("mcp-ipc-settings.png") });
  } finally {
    await app.close();
  }
});
