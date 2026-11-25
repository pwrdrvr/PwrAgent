import { addAbortListener } from "node:events";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { resolveActiveProfileDir, resolveBootstrapProfileDir } from "../profile";
import { getAppStateMode } from "../storage/desktop-runtime-storage";
import { withAntigravityModelCatalog } from "./acp-capability-freshness.js";
import { acpDiscoveryActionRequiredMessage } from "./acp-discovery-error.js";
import { acpAgentLaunchIdentity } from "./acp-launch-descriptor.js";
import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";
import { discoverAcpRuntimeCapabilities, type AcpRuntimeDiscoveryResult } from "./acp-runtime-discovery.js";

export type AcpRuntimeCapabilityProbeOptions = {
  /** Cancel this request. A shared probe stays alive for its other callers. */
  signal?: AbortSignal;
  onStage?: (stage: string) => void;
};

type RuntimeDiscoveryOptions = Parameters<typeof discoverAcpRuntimeCapabilities>[1];
type ManagedAntigravityProbe = {
  controller: AbortController;
  callers: Set<RuntimeDiscoveryOptions>;
  result: Promise<AcpRuntimeDiscoveryResult>;
  stage?: string;
};

const managedAntigravityProbes = new Map<string, ManagedAntigravityProbe>();

async function untilProbeAborted<T>(result: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await result;
  signal.throwIfAborted();
  const cancelled = Promise.withResolvers<never>();
  using _abort = addAbortListener(signal, () => cancelled.reject(signal.reason));
  return await Promise.race([result, cancelled.promise]);
}

async function discoverManagedAntigravityCapabilities(
  record: AcpInstalledAgentRecord,
  options: RuntimeDiscoveryOptions,
): Promise<AcpRuntimeDiscoveryResult> {
  options.signal?.throwIfAborted();
  // The discovery workspace scopes this to the profile. A replacement
  // binary or provider configuration gets an independent probe.
  const key = JSON.stringify([
    options.cwd,
    record.version,
    record.configDependencyFingerprint,
    acpAgentLaunchIdentity(record),
  ]);
  let active = managedAntigravityProbes.get(key);
  if (active?.controller.signal.aborted) {
    await untilProbeAborted(active.result.catch(() => undefined), options.signal);
    return await discoverManagedAntigravityCapabilities(record, options);
  }
  if (!active) {
    const controller = new AbortController();
    const callers = new Set<RuntimeDiscoveryOptions>();
    const run: ManagedAntigravityProbe = {
      controller,
      callers,
      result: Promise.resolve().then(() => discoverAcpRuntimeCapabilities(record, {
        ...options,
        signal: controller.signal,
        onStage: (stage) => {
          run.stage = stage;
          for (const caller of callers) caller.onStage?.(stage);
        },
      })).finally(() => managedAntigravityProbes.delete(key)),
    };
    managedAntigravityProbes.set(key, run);
    active = run;
  }
  active.callers.add(options);
  try {
    if (active.stage) options.onStage?.(active.stage);
    return await untilProbeAborted(active.result, options.signal);
  } finally {
    active.callers.delete(options);
    if (active.callers.size === 0 && managedAntigravityProbes.get(key) === active) {
      active.controller.abort(options.signal?.reason);
    }
  }
}

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
    const discoveryOptions = {
      cwd,
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.onStage ? { onStage: options.onStage } : {}),
    };
    const discover = record.registryId === "antigravity" && record.launchDescriptor?.managedAntigravityFallback === true
      ? discoverManagedAntigravityCapabilities : discoverAcpRuntimeCapabilities;
    const result = await discover(record, discoveryOptions);
    options?.signal?.throwIfAborted();
    let capabilities = result.runtimeCapabilities;
    if (capabilities && record.registryId === "antigravity" && record.runtimeCapabilities?.status === "stale") {
      // A sparse response can describe the protocol without answering the
      // model question. Keep the carried catalog until a model list arrives.
      const reportedModels = withAntigravityModelCatalog(capabilities)?.models;
      capabilities = reportedModels
        ? { ...capabilities, models: reportedModels }
        : { ...capabilities, status: "stale", models: record.runtimeCapabilities.models };
    }
    return {
      record: {
        ...record,
        ...(capabilities
          ? {
              runtimeCapabilities: capabilities,
              lastDiscoveredAt: capabilities.discoveredAt ?? now,
              lastDiscoveryError: undefined,
            }
          : {
              lastDiscoveredAt: now,
              // A session opened successfully even if it supplied no models.
              ...(acpDiscoveryActionRequiredMessage(record.registryId, record.lastDiscoveryError)
                ? { lastDiscoveryError: undefined }
                : {}),
            }),
        updatedAt: Math.max(record.updatedAt, now),
      },
    };
  } catch (error) {
    // A cancelled probe learned nothing about the runtime. Rethrow so the
    // caller keeps the previous record instead of stamping it as failed.
    options?.signal?.throwIfAborted();
    const message = error instanceof Error ? error.message : String(error);
    const actionRequired = acpDiscoveryActionRequiredMessage(record.registryId, message);
    const previousRestriction = acpDiscoveryActionRequiredMessage(record.registryId, record.lastDiscoveryError);
    return {
      record: {
        ...record,
        ...(actionRequired || previousRestriction ? { runtimeCapabilities: undefined } : {}),
        lastDiscoveryError: previousRestriction && !actionRequired ? record.lastDiscoveryError : message,
        updatedAt: Math.max(record.updatedAt, now),
      },
      error: actionRequired ?? message,
    };
  }
}

export async function ensureAcpRuntimeDiscoveryWorkspace(): Promise<string> {
  return await ensureProfileStateDirectory("acp-discovery-workspace");
}

/**
 * The cwd of one-shot ACP helper sessions. Agents keep history per cwd (Grok
 * keeps each prompt in a per-cwd prompt history that outlives the session), so
 * a helper never runs in a directory the operator works in.
 */
export async function ensureAcpHelperWorkspace(): Promise<string> {
  return await ensureProfileStateDirectory("acp-helper-workspace");
}

async function ensureProfileStateDirectory(name: string): Promise<string> {
  const directory = path.join(
    getAppStateMode() === "bootstrap"
      ? resolveBootstrapProfileDir()
      : resolveActiveProfileDir(),
    "state",
    name,
  );
  await mkdir(directory, { recursive: true });
  return directory;
}
