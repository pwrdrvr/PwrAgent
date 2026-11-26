import path from "node:path";
import { E2E_ACP_DISCOVERY_ROOT_ENV } from "../settings/desktop-settings-env";
import type { DiscoverAcpAgentInstancesOptions } from "./acp-instance-discovery";

/** Keep both Settings and owner discovery inside the E2E fixture's bin tree. */
export function resolveE2eAcpDiscoveryOptions(isPackaged: boolean | undefined): Pick<
  DiscoverAcpAgentInstancesOptions,
  "env" | "pathProbeRootDir" | "fallbackRootDir" | "bundledGrokCommand"
> | undefined {
  if (isPackaged !== false || process.env.PWRAGENT_E2E !== "1") return undefined;
  const root = process.env[E2E_ACP_DISCOVERY_ROOT_ENV];
  if (!root) return undefined;

  return {
    // Absolute candidates confine lookup. Keep PATH available to fixture CLIs
    // that use an interpreter such as `#!/usr/bin/env node`.
    env: process.env,
    pathProbeRootDir: path.join(root, ".local", "bin"),
    fallbackRootDir: root,
    bundledGrokCommand: null,
  };
}
