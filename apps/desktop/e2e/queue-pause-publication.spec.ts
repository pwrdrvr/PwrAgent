import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { exerciseDesktopPausePublication, exerciseDesktopWakeupPauseDurability } from "./fixtures/queue-pause-publication-driver";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { queuePausePublicationPlugin } from "./fixtures/queue-pause-publication-build";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

for (const initiallyPaused of [false, true]) {
  test(`Electron desktop ${initiallyPaused ? "resume" : "pause"} never republishes a cancelled waiting row`, async () => {
    let driverPath = "";
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
      async preLaunchHook(homeRoot) {
        driverPath = path.join(homeRoot, "desktop-pause-driver.cjs");
        await build({ entryPoints: [path.join(specDir, "fixtures/queue-pause-publication-driver.ts")], outfile: driverPath,
          bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
          define: { "import.meta.url": JSON.stringify(pathToFileURL(driverPath).href), "import.meta.dirname": JSON.stringify(homeRoot) },
          plugins: [queuePausePublicationPlugin(specDir, id => require.resolve(id))],
        });
      },
    });
    try {
      await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
      await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
      const result = await app.electronApp.evaluate(async (_electron, args) => {
        const driver = process.getBuiltinModule("node:module").createRequire(args.driverPath)(args.driverPath) as {
          exerciseDesktopPausePublication: typeof exerciseDesktopPausePublication;
        };
        return await driver.exerciseDesktopPausePublication(args.root, args.initiallyPaused);
      }, { driverPath, root: path.join(app.homeRoot, "isolated-pause-owner"), initiallyPaused });
      expect(result.cancelled).toMatchObject({ cancelled: true, disposition: "cancelled" });
      expect(result.statuses.at(-1)).toBe("cancelled");
      expect(result.waiting).toEqual([]);
      expect(result.nativeStarts).toBe(1);
      expect(result.input).toEqual([{ type: "text", text: "Invented immutable pause input" }]);
    } finally { await app.close(); }
  });
}

test("Electron concurrent Pause/Resume does not restore a sent wake-up as a project hold", async () => {
  let driverPath = "";
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      driverPath = path.join(homeRoot, "desktop-wakeup-pause-driver.cjs");
      await build({ entryPoints: [path.join(specDir, "fixtures/queue-pause-publication-driver.ts")], outfile: driverPath,
        bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
        define: { "import.meta.url": JSON.stringify(pathToFileURL(driverPath).href), "import.meta.dirname": JSON.stringify(homeRoot) },
        plugins: [queuePausePublicationPlugin(specDir, id => require.resolve(id))],
      });
    },
  });
  try {
    const result = await app.electronApp.evaluate(async (_electron, args) => {
      const driver = process.getBuiltinModule("node:module").createRequire(args.driverPath)(args.driverPath) as {
        exerciseDesktopWakeupPauseDurability: typeof exerciseDesktopWakeupPauseDurability;
      };
      return await driver.exerciseDesktopWakeupPauseDurability(args.root);
    }, { driverPath, root: path.join(app.homeRoot, "isolated-wakeup-owner") });
    expect(result).toMatchObject({ durableRows: 0, restoredHolds: 0, restoredWaiting: 0, paused: false, publishedPaused: false,
      unchangedInput: true, nativeStarts: 1 });
    expect(result.publishedRevision).toBe(result.revision);
  } finally { await app.close(); }
});
