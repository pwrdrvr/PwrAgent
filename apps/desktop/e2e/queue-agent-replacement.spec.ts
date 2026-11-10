import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { replacementHostDependencies } from "./fixtures/queue-agent-replacement-bundle";
import type { exerciseDesktopAgentReplacement } from "./fixtures/queue-agent-replacement-driver";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

for (const grouped of [false, true]) {
  test(`Electron desktop ${grouped ? "grouped" : "individual"} agent replacement retires its old identity`, async () => {
    let driverPath = "";
    const app = await launchElectronApp({
      fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
      async preLaunchHook(homeRoot) {
        driverPath = path.join(homeRoot, "desktop-replacement-driver.cjs");
        await build({ entryPoints: [path.join(specDir, "fixtures/queue-agent-replacement-driver.ts")], outfile: driverPath,
          bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
          define: { "import.meta.url": JSON.stringify(pathToFileURL(driverPath).href), "import.meta.dirname": JSON.stringify(homeRoot) },
          plugins: [replacementHostDependencies(specifier => require.resolve(specifier)), { name: "isolated-desktop-replacement-owner", setup(builder) {
            builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "replacement-raw" }));
            builder.onLoad({ filter: /.*/, namespace: "replacement-raw" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
            builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "replacement-owner" }));
            builder.onLoad({ filter: /.*/, namespace: "replacement-owner" }, () => ({
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
          exerciseDesktopAgentReplacement: typeof exerciseDesktopAgentReplacement;
        };
        return await driver.exerciseDesktopAgentReplacement(args.root, args.grouped);
      }, { driverPath, root: path.join(app.homeRoot, "isolated-replacement-owner"), grouped });
      expect(result.replacementId).not.toBe(result.originalId);
      expect(result.retired).toBe(true);
      expect(result.statuses).toEqual([[result.originalId, "cancelled"], [result.replacementId, "queued"]]);
      expect(result.waiting).toEqual([...(grouped ? ["group-review"] : []), result.replacementId, "replacement-neighbor"]);
      expect(result.text).toContain("Fresh Alice input");
      expect(result.text).not.toContain("Original Alice input");
      if (grouped) {
        expect(result.text).toContain("Unchanged Bob input");
        expect(result.untouchedSenderText).toContain("Fresh Bob input");
        expect(result.untouchedSenderText).toContain("Fresh Alice input");
      } else {
        expect(result.cancelledReceipt).toContain("Fresh receipt input");
        expect(result.cancelledReceipt).toContain("Cancelled");
        expect(result.cancelledReceipt).not.toContain("Queued");
      }
      expect(result.nativeStarts).toBe(1);
      if (grouped) expect(result.held).toBe(true);
      else { expect(result.paused).toBe(true); expect(result.pauseRevision).toBe(1); }
    } finally { await app.close(); }
  });
}
