import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfileDir, resolveBootstrapProfileDir } from "../profile";
import { getAppStateMode } from "../state/app-state";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";
import { discoverAcpRuntimeCapabilities } from "./acp-runtime-discovery.js";

import { CLAUDE_ACP_REGISTRY_ID, isClaudeAcpAuthenticationError } from "./claude-acp-runtime";

export type AcpRuntimeCapabilityProbeOptions = {
  /** Terminates the agent; the probe then rejects instead of recording. */
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
};

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
  options?: AcpRuntimeCapabilityProbeOptions,
): Promise<AcpInstalledAgentRecord> {
  return (
    await probeAcpRuntimeCapabilities(record, cwd, requestTimeoutMs, options)
  ).record;
}

/**
 * `refreshAcpRuntimeCapabilities`, plus whether this probe failed. The record
 * alone cannot say: a probe that yields no capabilities leaves an earlier
 * probe's `lastDiscoveryError` in place.
 */
export async function probeAcpRuntimeCapabilities(
  record: AcpInstalledAgentRecord,
  cwd: string,
  requestTimeoutMs?: number,
  options?: AcpRuntimeCapabilityProbeOptions,
): Promise<{ record: AcpInstalledAgentRecord; error?: string }> {
  const now = Date.now();
  try {
    const result = await discoverAcpRuntimeCapabilities(record, {
      cwd,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.onStage ? { onStage: options.onStage } : {}),
    });
    return {
      record: {
        ...record,
        ...(record.registryId === CLAUDE_ACP_REGISTRY_ID
          ? { authStatus: "authenticated" as const }
          : {}),
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
      },
    };
  } catch (error) {
    // A cancelled probe learned nothing about the runtime. Rethrow so the
    // caller keeps the previous record instead of stamping it as failed.
    options?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    return {
      record: {
        ...record,
        ...(record.registryId === CLAUDE_ACP_REGISTRY_ID
          ? { authStatus: isClaudeAcpAuthenticationError(error) ? "required" as const : "failed" as const }
          : {}),
        lastDiscoveryError: message,
        updatedAt: Math.max(record.updatedAt, now),
      },
      error: message,
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
