import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { replacementHostDependencies } from "./fixtures/queue-agent-replacement-bundle";
import type { exerciseExplicitQueueIdentity } from "./fixtures/queue-explicit-identity-driver";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

test("Electron ordinary explicit identities deduplicate retries and refuse changed input", async () => {
  let driverPath = "";
  const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      driverPath = path.join(homeRoot, "explicit-identity-driver.cjs");
      await build({ entryPoints: [path.join(specDir, "fixtures/queue-explicit-identity-driver.ts")], outfile: driverPath,
        bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
        define: { "import.meta.url": JSON.stringify(pathToFileURL(driverPath).href), "import.meta.dirname": JSON.stringify(homeRoot) },
        plugins: [replacementHostDependencies(specifier => require.resolve(specifier)), { name: "explicit-identity-owner", setup(builder) {
          builder.onResolve({ filter: /\?raw$/ }, args => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: "identity-raw" }));
          builder.onLoad({ filter: /.*/, namespace: "identity-raw" }, async args => ({ contents: await readFile(args.path, "utf8"), loader: "text" }));
          builder.onResolve({ filter: /(?:^|\/)stdio-transport$/ }, () => ({ path: "fixture-codex", namespace: "identity-owner" }));
          builder.onLoad({ filter: /.*/, namespace: "identity-owner" }, () => ({
            contents: `export { OwnerConformanceCodexTransport as StdioJsonRpcTransport } from ${JSON.stringify(path.resolve(specDir, "../src/main/__tests__/fixtures/owner-conformance-codex-transport.ts"))};`,
            loader: "ts", resolveDir: specDir,
          }));
        } }],
      });
    } });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const result = await app.electronApp.evaluate(async (_electron, args) => {
      const driver = process.getBuiltinModule("node:module").createRequire(args.driverPath)(args.driverPath) as {
        exerciseExplicitQueueIdentity: typeof exerciseExplicitQueueIdentity;
      };
      return await driver.exerciseExplicitQueueIdentity(args.root);
    }, { driverPath, root: path.join(app.homeRoot, "isolated-explicit-owner") });
    expect(result.ids).toEqual(["explicit-identity", "explicit-identity", "explicit-identity"]);
    expect(result.changedRefused).toBe(true);
    expect(result.retired).toBe(true);
    expect(result.cancelled).toBe("cancelled");
    expect(result.statuses).toEqual(["queued", "queued", "cancelled"]);
    expect(result.nativeStarts).toBe(1);
  } finally { await app.close(); }
});
