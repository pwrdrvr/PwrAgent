import { existsSync } from "node:fs";
import { resolve } from "node:path";

export const BUNDLED_GROK_RELATIVE_PATH = ["agents", "grok"] as const;

export function resolveBundledGrokCommand(options?: {
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
}): string | undefined {
  const resourcesPath = options?.resourcesPath ?? process.resourcesPath;
  if (!resourcesPath) {
    return undefined;
  }
  const executable = (options?.platform ?? process.platform) === "win32"
    ? "grok.exe"
    : "grok";
  const command = resolve(
    resourcesPath,
    ...BUNDLED_GROK_RELATIVE_PATH,
    executable,
  );
  return (options?.exists ?? existsSync)(command) ? command : undefined;
}
