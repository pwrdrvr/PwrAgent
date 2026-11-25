import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fc from "fast-check";
import { afterAll, expect, it } from "vitest";
import { readNodeRuntimeMetadata, resolveMainEntryPath, runtimeResourcesPath } from "../runtime-resources";

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

it("resolves sibling main entry files from out/main even when the caller is code-split into out/main/chunks", () => {
  let layoutId = 0;
  fc.assert(fc.property(
    fc.boolean(),
    fc.constantFrom(
      "mcp-connection-bridge.js",
      "storage-maintenance-worker.js",
      "claude-session-reader-worker.js",
      "token-miser-hook.js",
    ),
    (inChunks, entryFileName) => {
      const outMain = path.join(root, `main-entry-${layoutId++}`, "out/main");
      const callerDir = inChunks ? path.join(outMain, "chunks") : outMain;
      fs.mkdirSync(callerDir, { recursive: true });
      const expected = path.join(outMain, entryFileName);
      fs.writeFileSync(expected, "");
      expect(resolveMainEntryPath(entryFileName, callerDir)).toBe(expected);
    },
  ));

  const gatewaySource = fs.readFileSync(
    path.resolve(import.meta.dirname, "../mcp-connections/mcp-connection-gateway-service.ts"),
    "utf8",
  );
  // A direct join(__dirname, "mcp-connection-bridge.js") breaks whenever
  // Rolldown emits McpConnectionGatewayService inside out/main/chunks/.
  expect(gatewaySource).not.toContain('join(__dirname, "mcp-connection-bridge.js")');
});
