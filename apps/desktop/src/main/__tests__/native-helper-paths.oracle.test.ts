import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { expect, it, onTestFinished } from "vitest";

it("both native consumers select the build output in development and resource output when packaged", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "native-helper-layout-")));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.resolve(import.meta.dirname, "..");
  const bundle = await build({
    stdin: { contents: `import { maintenanceLockHelperPath } from "./app-server/maintenance-native-lock";
      import { oracleHelperPath } from "./mcp-connections/mcp-ipc-http";
      console.log(JSON.stringify([maintenanceLockHelperPath(), oracleHelperPath()]));`, resolveDir: main, loader: "ts" },
    bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
    define: { "import.meta.url": "__pwragentModuleUrl" },
    banner: { js: 'const __pwragentModuleUrl = require("node:url").pathToFileURL(__filename).href;' },
    plugins: [{ name: "observe-private-helper-selection", setup(builder) {
      // Expose the actual local-MCP selector without changing its public API.
      builder.onLoad({ filter: /mcp-ipc-http\.ts$/ }, (args) => ({
        contents: fs.readFileSync(args.path, "utf8") + "\nexport { helperPath as oracleHelperPath };", loader: "ts",
      }));
    } }],
  });
  for (const host of ["node", "electron"] as const) {
    for (const packaged of [false, true]) {
      const app = path.join(root, `${host}-${packaged ? "packaged" : "development"}`);
      const out = path.join(app, "out", host === "node" ? "headless" : "main");
      const resources = path.join(app, "resources");
      fs.mkdirSync(out, { recursive: true });
      if (!packaged) {
        fs.mkdirSync(path.join(app, "src/main"), { recursive: true });
        fs.writeFileSync(path.join(app, "src/main/index.ts"), "");
      }
      if (host === "node") fs.writeFileSync(path.join(out, "runtime.json"), JSON.stringify({ version: 1, appVersion: "1.0.0", appRoot: "../..", resources: "../../resources" }));
      const program = path.join(out, "consumer.cjs");
      fs.writeFileSync(program, bundle.outputFiles[0]!.text);
      const filename = `mcp-ipc-relay${process.platform === "win32" ? ".exe" : ""}`;
      const expected = packaged
        ? path.join(resources, "mcp-ipc-relay", filename)
        : path.join(app, "build/mcp-ipc-relay", `${process.platform}-${process.arch}`, filename);
      const bootstrap = host === "electron"
        ? `process.resourcesPath = ${JSON.stringify(resources)}; process.defaultApp = ${!packaged};`
        : "";
      const output = execFileSync(process.execPath, ["-e", `${bootstrap} require(${JSON.stringify(program)});`], { encoding: "utf8" });
      expect(JSON.parse(output), `${host}, packaged=${packaged}`).toEqual([expected, expected]);
    }
  }
});
