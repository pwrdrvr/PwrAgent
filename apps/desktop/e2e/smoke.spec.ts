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
  } finally {
    await app.close();
  }
});

test("titles the shell window from the main process, not the renderer document", async () => {
  const app = await launchElectronApp({
    fixturePath: path.resolve(
      smokeSpecDir,
      "fixtures/smoke/replay.fixture.json"
    )
  });

  try {
    // Gate on a mounted renderer. The clobber this guards against
    // happened when the page finished loading and Electron mirrored
    // index.html's stale <title>PwrAgnt</title> onto the window, so
    // sampling the title before the renderer mounts would pass for the
    // wrong reason.
    await expect(
      app.window.getByRole("button", { name: /Replay smoke thread/i }).first()
    ).toBeVisible();

    const titles = await app.electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => win.getTitle())
    );

    // Asserted by membership, not by the whole list: opening another
    // window during boot is someone else's feature, not this
    // regression. A single read, not a poll — the title must be right
    // once the renderer has loaded, and a retry loop would happily
    // pass on a sample taken before a later clobber.
    expect(titles).toContain("PwrAgent");
    expect(titles).not.toContain("PwrAgnt");
  } finally {
    await app.close();
  }
});
