import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// A fresh workspace install precedes the build which copies the approved host
// tools. Packed installations always contain the runtime manifest.
if (!existsSync(path.join(root, "dist/runtime.json"))) {
  if (!existsSync(path.join(root, "../../apps/desktop/scripts/build-headless.mjs"))) {
    throw new Error("The Outpost package is incomplete: runtime.json is missing.");
  }
} else {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Outpost supports Linux and macOS.");
  const { buildMcpIpcRelay } = await import("./build-mcp-ipc-relay.mjs");
  const { stageRuntime } = await import("./stage-runtime.mjs");
  const helperDirectory = path.join(root, "resources/mcp-ipc-relay");
  mkdirSync(helperDirectory, { recursive: true });
  copyFileSync(buildMcpIpcRelay({ outputRoot: root, packaged: true }), path.join(helperDirectory, "mcp-ipc-relay"));
  await stageRuntime({ manifestPath: path.join(root, "resources/custom-git-runtime.json"),
    platform: process.platform, arch: process.arch, output: path.join(root, "resources/git"), cache: process.env.PWRGIT_RUNTIME_CACHE });
}
