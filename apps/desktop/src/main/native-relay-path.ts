import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentRuntime, runtimeResourcesPath } from "./runtime-resources";

/** Bundled entries run under out/main or out/headless. Installed helpers live outside ASAR. */
export function nativeRelayPath(): string {
  const filename = process.platform === "win32" ? "mcp-ipc-relay.exe" : "mcp-ipc-relay";
  const resources = runtimeResourcesPath();
  return !isDevelopmentRuntime() && resources
    ? path.join(resources, "mcp-ipc-relay", filename)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/mcp-ipc-relay", process.platform + "-" + process.arch, filename);
}
