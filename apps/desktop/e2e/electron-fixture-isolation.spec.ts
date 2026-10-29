import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";

const fixturePath = path.resolve(import.meta.dirname, "fixtures/smoke/replay.fixture.json");

test("owns Chromium storage per Electron process and removes it after close", async () => {
  const first = await launchElectronApp({ fixturePath });
  let second: Awaited<ReturnType<typeof launchElectronApp>> | undefined;
  try {
    const firstPaths = await first.electronApp.evaluate(({ app }) => ({
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
    }));
    await first.window.evaluate(() => localStorage.setItem("fixture-owner", "first"));

    // Profiles can share the application database. Chromium's native storage
    // still needs a separate owner, including when a profile helper relaunches.
    second = await launchElectronApp({
      fixturePath,
      homeRoot: first.homeRoot,
      env: { PWRAGENT_E2E_CHROMIUM_ROOT: "must-be-overridden" },
    });
    const secondPaths = await second.electronApp.evaluate(({ app }) => ({
      userData: app.getPath("userData"),
      sessionData: app.getPath("sessionData"),
    }));
    for (const directory of [...Object.values(firstPaths), ...Object.values(secondPaths)]) {
      expect(path.isAbsolute(directory)).toBe(true);
      const relative = path.relative(first.homeRoot, directory);
      expect(relative).not.toBe("");
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    }
    expect(secondPaths.userData).not.toBe(firstPaths.userData);
    expect(secondPaths.sessionData).not.toBe(firstPaths.sessionData);
    expect(await second.window.evaluate(() => localStorage.getItem("fixture-owner"))).toBeNull();

    // This must use the normal close policy while the other storage owner is
    // alive. A native LevelDB lock wait previously outlived the app's quit phases.
    await first.closeApplication();
    await second.window.evaluate(() => localStorage.setItem("fixture-owner", "second"));
    expect(await second.window.evaluate(() => localStorage.getItem("fixture-owner"))).toBe("second");
    await second.close();
    second = undefined;
    expect(existsSync(first.homeRoot)).toBe(false);
  } finally {
    try {
      await second?.close();
    } finally {
      await first.close();
    }
  }
});
