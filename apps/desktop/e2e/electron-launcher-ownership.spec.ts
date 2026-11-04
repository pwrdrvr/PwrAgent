import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));

test("Windows owns the native Electron process and closes its launcher pipes", async () => {
  test.skip(process.platform !== "win32", "Windows launcher ownership");
  const literalArgument = "--pwragent-e2e-launcher-value=space & \"quoted\" value";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    extraArgs: [literalArgument],
  });
  const launcher = app.electronApp.process();
  let launcherClosed = false;
  launcher.once("close", () => { launcherClosed = true; });
  try {
    const main = await app.electronApp.evaluate(() => ({
      pid: process.pid,
      args: process.argv,
    }));
    expect(launcher.pid).toBe(main.pid);
    expect(main.args).toContain(literalArgument);
  } finally {
    await app.close();
  }
  expect(launcherClosed).toBe(true);
});
