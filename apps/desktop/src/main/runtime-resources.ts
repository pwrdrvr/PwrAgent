import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NodeRuntimeMetadata {
  version: string;
  appRoot: string;
  resourcesPath: string;
  isPackaged: boolean;
}
const metadata = new Map<string, NodeRuntimeMetadata | undefined>();

/** The build writes this manifest beside every Node entry, including workers. */
export function readNodeRuntimeMetadata(moduleUrl = import.meta.url): NodeRuntimeMetadata | undefined {
  if (metadata.has(moduleUrl)) return metadata.get(moduleUrl);
  const directory = path.dirname(fileURLToPath(moduleUrl));
  let parsed: { version: number; appVersion: string; appRoot: string; resources: string };
  try { parsed = JSON.parse(readFileSync(path.join(directory, "runtime.json"), "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") { metadata.set(moduleUrl, undefined); return undefined; }
    throw error;
  }
  if (parsed.version !== 1 || typeof parsed.appVersion !== "string" || typeof parsed.appRoot !== "string" || typeof parsed.resources !== "string") {
    throw new Error("The Node runtime manifest is invalid. Rebuild or reinstall PwrAgent.");
  }
  const appRoot = path.resolve(directory, parsed.appRoot);
  const value = {
    version: parsed.appVersion, appRoot, resourcesPath: path.resolve(directory, parsed.resources),
    isPackaged: !existsSync(path.join(appRoot, "src/main/index.ts")),
  };
  metadata.set(moduleUrl, value);
  return value;
}

/** Resolve the same asset root in Electron, its Node helpers, and plain Node. */
export function runtimeResourcesPath(moduleUrl = import.meta.url): string | undefined {
  if (typeof process.resourcesPath === "string") return process.resourcesPath;
  const runtime = readNodeRuntimeMetadata(moduleUrl);
  if (runtime) return runtime.resourcesPath;
  // Electron's runAsNode helpers do not always expose resourcesPath. Their
  // script remains inside app.asar, beside the packaged Resources directory.
  let ancestor = path.dirname(fileURLToPath(moduleUrl));
  while (path.dirname(ancestor) !== ancestor) {
    if (path.basename(ancestor) === "app.asar") return path.dirname(ancestor);
    ancestor = path.dirname(ancestor);
  }
  return undefined;
}

export function isDevelopmentRuntime(): boolean {
  return process.defaultApp === true || readNodeRuntimeMetadata()?.isPackaged === false;
}
