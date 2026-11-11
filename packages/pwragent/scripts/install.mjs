import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// package.json gates dependency-only workspace installs on this local marker.
// A packed install and the package builder both supply it before calling here.
if (!existsSync(path.join(root, "dist/runtime.json"))) throw new Error("The Outpost package is incomplete: runtime.json is missing.");
{
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Outpost supports Linux and macOS.");
  const { buildMcpIpcRelay } = await import("./build-mcp-ipc-relay.mjs");
  const { stageRuntime } = await import("./stage-runtime.mjs");
  const helperDirectory = path.join(root, "resources/mcp-ipc-relay");
  mkdirSync(helperDirectory, { recursive: true });
  copyFileSync(buildMcpIpcRelay({ outputRoot: root, packaged: true }), path.join(helperDirectory, "mcp-ipc-relay"));
  await stageRuntime({ manifestPath: path.join(root, "resources/custom-git-runtime.json"),
    platform: process.platform, arch: process.arch, output: path.join(root, "resources/git"), cache: process.env.PWRGIT_RUNTIME_CACHE });
}
