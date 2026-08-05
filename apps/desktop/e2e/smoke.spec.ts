import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const smokeSpecDir = path.dirname(fileURLToPath(import.meta.url));

test("loads the desktop shell without eager skill or manual refresh requests", async () => {
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
      app.window.getByRole("button", { name: /Refresh threads/i })
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("button", { name: /^Refresh$/i })
    ).toHaveCount(0);
    await expect(
      app.window.getByRole("tab", {
        name: "Thread info"
      })
    ).toBeVisible();

    // The OS-level window title is owned by the main process, not the
    // renderer document. The renderer's <title> used to clobber it on
    // load, leaving every local window named "PwrAgnt" — the pre-rename
    // spelling baked into index.html.
    await expect
      .poll(async () =>
        await app.electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => win.getTitle())
        )
      )
      .toEqual(["PwrAgent"]);
  } finally {
    await app.close();
  }
});
