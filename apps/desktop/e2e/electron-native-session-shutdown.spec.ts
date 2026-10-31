import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Windows closes newly created persistent Chromium sessions", async () => {
  test.skip(process.platform !== "win32", "Windows native storage shutdown");
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  const launcher = app.electronApp.process();
  let launcherClosed = false;
  launcher.once("close", () => { launcherClosed = true; });
  try {
    const initialized = await app.electronApp.evaluate(async ({ BrowserWindow, session }) => {
      const storagePaths: string[] = [];
      for (const partition of ["persist:e2e-shutdown-first", "persist:e2e-shutdown-second"]) {
        const ownedSession = session.fromPartition(partition);
        const window = new BrowserWindow({
          show: false,
          webPreferences: { session: ownedSession },
        });
        await window.loadURL("about:blank");
        storagePaths.push(ownedSession.getStoragePath()!);
      }
      return {
        storagePaths,
        electron: process.versions.electron,
        chromium: process.versions.chrome,
      };
    });
    await test.info().attach("native-runtime", {
      body: JSON.stringify({ electron: initialized.electron, chromium: initialized.chromium }),
      contentType: "application/json",
    });
    expect(new Set(initialized.storagePaths).size).toBe(2);
    for (const storagePath of initialized.storagePaths) {
      const relative = path.relative(app.homeRoot, storagePath);
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative.startsWith("..")).toBe(false);
    }
  } finally {
    await app.close();
  }
  expect(launcherClosed).toBe(true);
});
