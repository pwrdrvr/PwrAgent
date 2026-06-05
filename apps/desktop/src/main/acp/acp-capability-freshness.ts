import type { AcpInstalledAgentRecord } from "./acp-registry-types.js";

/**
 * How long a persisted ACP runtime-capability probe stays "fresh" before a
 * refresh will re-launch the agent to re-probe it. Capabilities (model lists,
 * supported modes) change rarely, and each probe spawns a real agent process
 * over ACP — so we cache aggressively and only re-probe every couple of days.
 */
export const ACP_CAPABILITY_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48 hours

/**
 * Decide whether a discovered ACP agent needs its (expensive) runtime
 * capabilities re-probed, or whether the persisted capabilities can be reused.
 *
 * The expensive probe (`discoverAcpRuntimeCapabilities`) launches the agent
 * over ACP. We avoid it whenever we already hold a fresh, version-matched
 * result. A re-probe is warranted when:
 *
 *  - `force` is requested (the "Discover new" button), OR
 *  - the agent has never been probed (no persisted capabilities / timestamp), OR
 *  - the installed CLI version changed since the last probe (capabilities may
 *    have changed), OR
 *  - the persisted probe is older than `maxAgeMs`.
 *
 * @param cached            The currently-persisted record for this agent, if any.
 * @param discoveredVersion The CLI version from the latest cheap local discovery.
 * @param now               Current epoch millis (injectable for tests).
 */
export function shouldReprobeAcpCapabilities(
  cached: AcpInstalledAgentRecord | undefined,
  discoveredVersion: string | undefined,
  now: number,
  options?: { force?: boolean; maxAgeMs?: number },
): boolean {
  if (options?.force === true) {
    return true;
  }
  // Never probed, or a prior probe produced no capabilities.
  if (
    cached === undefined ||
    cached.runtimeCapabilities === undefined ||
    cached.lastDiscoveredAt === undefined
  ) {
    return true;
  }
  // CLI upgraded/downgraded since the last probe → capabilities may differ.
  if (
    discoveredVersion !== undefined &&
    cached.version !== undefined &&
    discoveredVersion !== cached.version
  ) {
    return true;
  }
  // Stale.
  const maxAgeMs = options?.maxAgeMs ?? ACP_CAPABILITY_MAX_AGE_MS;
  return now - cached.lastDiscoveredAt > maxAgeMs;
}
