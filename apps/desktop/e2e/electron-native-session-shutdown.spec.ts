import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Windows retains the inspector owner until session cleanup completes", async () => {
  test.skip(process.platform !== "win32", "Windows native storage shutdown");
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
  });
  try {
    await app.electronApp.evaluate(({ session }) => {
      const owner = globalThis as typeof globalThis & {
        __e2eCacheDrain?: { entered: boolean; release?: () => void };
      };
      const pending = { entered: false, release: undefined as (() => void) | undefined };
      owner.__e2eCacheDrain = pending;
      const ownedSession = session.defaultSession;
      const clearData = ownedSession.clearData.bind(ownedSession);
      ownedSession.clearData = async (options) => {
        await new Promise<void>((resolve) => {
          pending.release = resolve;
          pending.entered = true;
        });
        await clearData(options);
      };
    });
    const closing = app.closeApplication();
    closing.catch(() => undefined);
    await expect.poll(async () => await app.electronApp.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __e2eCacheDrain?: { entered: boolean };
      };
      return owner.__e2eCacheDrain?.entered ?? false;
    })).toBe(true);
    await app.electronApp.evaluate(() => {
      const owner = globalThis as typeof globalThis & {
        __e2eCacheDrain?: { release?: () => void };
      };
      owner.__e2eCacheDrain?.release?.();
    });
    await closing;
  } finally {
    await app.close();
  }
});

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
