import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfileDir, resolveBootstrapProfileDir } from "../profile";
import { getAppStateMode } from "../state/app-state";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";
import { discoverAcpRuntimeCapabilities } from "./acp-runtime-discovery.js";

/**
 * Probe an agent's runtime capabilities over ACP and fold the outcome into its
 * record. A probe that yields nothing still stamps `lastDiscoveredAt`, and a
 * failure is recorded as `lastDiscoveryError`, so callers can tell a probed
 * runtime from one that was never probed.
 */
export async function refreshAcpRuntimeCapabilities(
  record: AcpInstalledAgentRecord,
  cwd: string,
  requestTimeoutMs?: number,
): Promise<AcpInstalledAgentRecord> {
  const now = Date.now();
  try {
    const result = await discoverAcpRuntimeCapabilities(record, {
      cwd,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    });
    return {
      ...record,
      ...(result.runtimeCapabilities
        ? {
            runtimeCapabilities: result.runtimeCapabilities,
            lastDiscoveredAt: result.runtimeCapabilities.discoveredAt ?? now,
            lastDiscoveryError: undefined,
          }
        : {
            lastDiscoveredAt: now,
          }),
      updatedAt: Math.max(record.updatedAt, now),
    };
  } catch (error) {
    return {
      ...record,
      lastDiscoveryError: error instanceof Error ? error.message : String(error),
      updatedAt: Math.max(record.updatedAt, now),
    };
  }
}

export async function ensureAcpRuntimeDiscoveryWorkspace(): Promise<string> {
  const directory = path.join(
    getAppStateMode() === "bootstrap"
      ? resolveBootstrapProfileDir()
      : resolveActiveProfileDir(),
    "state",
    "acp-discovery-workspace",
  );
  await mkdir(directory, { recursive: true });
  return directory;
}
