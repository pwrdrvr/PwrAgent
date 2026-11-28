import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDevelopmentRuntime, runtimeResourcesPath } from "./runtime-resources";

/** Bundled entries run under out/main or out/headless. Installed helpers live outside ASAR. */
export function nativeRelayPath(): string {
  return nativeRelayResource("mcp-ipc-relay", "mcp-ipc-relay");
}

export function nativeStdioRelayPath(): string {
  return nativeRelayResource("mcp-stdio-relay", "pwragent-mcp-stdio-relay");
}

function nativeRelayResource(directory: string, name: string): string {
  const filename = name + (process.platform === "win32" ? ".exe" : "");
  const resources = runtimeResourcesPath();
  return !isDevelopmentRuntime() && resources
    ? path.join(resources, directory, filename)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build", directory, process.platform + "-" + process.arch, filename);
}
