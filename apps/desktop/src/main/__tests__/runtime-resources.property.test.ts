import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, expect, it } from "vitest";
import { readNodeRuntimeMetadata, runtimeResourcesPath } from "../runtime-resources";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-runtime-resources-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
it("resolves versions, resources and packaged state from the same layout for each Node entry", () => {
  let id = 0;
  fc.assert(fc.property(fc.boolean(), fc.constantFrom("index", "claude-session-reader-worker", "storage-maintenance-worker", "mcp-connection-bridge", "token-miser-hook"), (packaged, name) => {
    const app = path.join(root, `app-${id++}`);
    const out = path.join(app, "out/headless");
    fs.mkdirSync(out, { recursive: true });
    if (!packaged) {
      fs.mkdirSync(path.join(app, "src/main"), { recursive: true });
      fs.writeFileSync(path.join(app, "src/main/index.ts"), "");
    }
    fs.writeFileSync(path.join(out, "runtime.json"), JSON.stringify({ version: 1, appVersion: "1.2.3", appRoot: "../..", resources: "../../resources" }));
    const url = pathToFileURL(path.join(out, `${name}.js`)).href;
    expect(readNodeRuntimeMetadata(url)).toEqual({ version: "1.2.3", appRoot: app, resourcesPath: path.join(app, "resources"), isPackaged: packaged });
    expect(runtimeResourcesPath(url)).toBe(path.join(app, "resources"));
  }));
});
