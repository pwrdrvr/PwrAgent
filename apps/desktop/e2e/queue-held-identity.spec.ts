import path from "node:path";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { replacementHostDependencies } from "./fixtures/queue-agent-replacement-bundle";
import type { exerciseHeldQueueIdentity } from "./fixtures/queue-held-identity-driver";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));

test("Electron held identities preserve owner and review intent across retries", async () => {
  let driverPath = "";
  const app = await launchElectronApp({ fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    async preLaunchHook(homeRoot) {
      driverPath = path.join(homeRoot, "held-identity-driver.cjs");
      await build({ entryPoints: [path.join(specDir, "fixtures/queue-held-identity-driver.ts")], outfile: driverPath,
        bundle: true, platform: "node", format: "cjs", logLevel: "silent", external: ["electron"],
        define: { "import.meta.url": JSON.stringify(pathToFileURL(driverPath).href), "import.meta.dirname": JSON.stringify(homeRoot) },
        plugins: [replacementHostDependencies(specifier => require.resolve(specifier)), { name: "held-identity-owner", setup(builder) {
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
        exerciseHeldQueueIdentity: typeof exerciseHeldQueueIdentity;
      };
      return await driver.exerciseHeldQueueIdentity(args.root);
    }, { driverPath, root: path.join(app.homeRoot, "isolated-held-owner") });
    expect(result.ordinaryRefused).toBe(true);
    expect(result.ownerRefused).toBe(true);
    expect(result.causeRefused).toBe(true);
    expect(result.scheduledRefused).toBe(true);
    expect(result.ids).toEqual(["held-identity", "held-identity", "held-identity"]);
    expect(result.unchanged).toBe(true);
    expect(result.nativeStarts).toBe(1);
    expect(result.retryStatuses).toEqual(["held", "started", "started"]);
    expect(result.retryRequests).toBe(4);
  } finally { await app.close(); }
});
