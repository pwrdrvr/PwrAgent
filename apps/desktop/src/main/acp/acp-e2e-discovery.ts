import { statSync } from "node:fs";
import path from "node:path";
import { E2E_ACP_DISCOVERY_ROOT_ENV } from "../settings/desktop-settings-env";
import type { DiscoverAcpAgentInstancesOptions } from "./acp-instance-discovery";

/** Keep both Settings and owner discovery inside the E2E fixture's bin tree. */
export function resolveE2eAcpDiscoveryOptions(isPackaged: boolean | undefined): Pick<
  DiscoverAcpAgentInstancesOptions,
  "env" | "pathProbeRootDir" | "listExecutables" | "fallbackRootDir" | "bundledGrokCommand"
> | undefined {
  if (isPackaged !== false || process.env.PWRAGENT_E2E !== "1") return undefined;
  const root = process.env[E2E_ACP_DISCOVERY_ROOT_ENV];
  if (!root) return undefined;

  return {
    // Absolute candidates confine lookup. Keep PATH available to fixture CLIs
    // that use an interpreter such as `#!/usr/bin/env node`.
    env: process.env,
    pathProbeRootDir: path.join(root, ".local", "bin"),
    ...(process.platform === "win32" ? { listExecutables: listWindowsFixtureExecutables } : {}),
    fallbackRootDir: root,
    bundledGrokCommand: null,
  };
}

function listWindowsFixtureExecutables(command: string, env: NodeJS.ProcessEnv): string[] {
  // pathProbeRootDir makes the command absolute before the kit calls the
  // lister. Enumerate shims beside that path without consulting the host PATH.
  const pathExtKey = Object.keys(env).find((key) => key.toUpperCase() === "PATHEXT");
  const pathExt = pathExtKey && env[pathExtKey]?.trim();
  const extensions = (pathExt || ".COM;.EXE;.BAT;.CMD").split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.?[\w-]+$/.test(extension))
    .map((extension) => extension.startsWith(".") ? extension : `.${extension}`);
  const commandExt = path.extname(command).toLowerCase();
  const candidates = extensions.some((extension) => extension.toLowerCase() === commandExt)
    ? [command]
    : extensions.map((extension) => `${command}${extension}`);
  return candidates.filter((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
