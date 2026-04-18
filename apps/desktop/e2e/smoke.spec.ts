import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const smokeSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("loads the desktop shell from a replay fixture", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      smokeSpecDir,
      "fixtures/smoke/replay.fixture.json"
    )
  });

  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(
      app.window.getByRole("heading", {
        level: 2,
        name: "Replay smoke thread"
      })
    ).toBeVisible();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    await expect(
      app.window.getByRole("button", {
        name: "Open context rail"
      })
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
