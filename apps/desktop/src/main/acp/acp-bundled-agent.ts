import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";

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
  const platform = options?.platform ?? process.platform;
  const executable = platform === "win32" ? "grok.exe" : "grok";
  const pathApi = platform === "win32" ? win32 : posix;
  const command = pathApi.resolve(
    resourcesPath,
    ...BUNDLED_GROK_RELATIVE_PATH,
    executable,
  );
  return (options?.exists ?? existsSync)(command) ? command : undefined;
}
