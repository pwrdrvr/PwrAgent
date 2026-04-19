import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("shows only the Codex Desktop search-product threads in directory browse mode", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      specDir,
      "fixtures/codex-directory-parity/replay.fixture.json"
    )
  });

  try {
    const sidebar = app.window.locator(".sidebar");

    await app.window.getByRole("button", { name: "directories" }).click();

    await expect(sidebar.getByText("search-product ProjMgr")).toBeVisible();
    await expect(sidebar.getByText("Plan Slidev theme extraction")).toBeVisible();
    await expect(sidebar.getByText("Create Project Manager deck")).toBeVisible();

    await expect(sidebar.getByText("is this thing on?")).toHaveCount(0);
    await expect(sidebar.getByText("Gather Reddit feedback screenshots")).toHaveCount(0);
  } finally {
    await app.close();
  }
});
