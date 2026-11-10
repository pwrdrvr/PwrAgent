import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import type { exerciseDesktopPausePublication } from "./fixtures/queue-pause-publication-driver";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

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
          plugins: [{ name: "isolated-desktop-pause-owner", setup(builder) {
            builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "pause-raw" }));
            builder.onLoad({ filter: /.*/, namespace: "pause-raw" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
            builder.onResolve({ filter: /^[^./]/ }, args => {
              if (args.path.startsWith("node:") || args.path === "electron"
                || args.path.startsWith("@pwragent/") || args.path.startsWith("@pwrdrvr/codex-app-server-protocol")) return;
              try { return { path: require.resolve(args.path), external: true }; } catch { return; }
            });
            builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "pause-owner" }));
            builder.onLoad({ filter: /.*/, namespace: "pause-owner" }, () => ({
              contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(path.resolve(specDir, "../src/main/__tests__/fixtures/owner-conformance-codex-transport.ts"))};`,
              loader: "ts", resolveDir: specDir,
            }));
          } }],
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
