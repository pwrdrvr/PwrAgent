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
 *  - the agent has never been probed (no persisted timestamp), OR
 *  - a prior probe completed but produced no capabilities — treated as a
 *    degraded/transient result on purpose, so the agent self-heals on the next
 *    refresh instead of caching an empty capability set for `maxAgeMs`, OR
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
  // Never probed, or a probe that completed but yielded no capabilities. The
  // latter is re-probed on purpose (degraded/transient self-heal) rather than
  // cached — see the doc comment above. Probe *errors* don't set
  // `lastDiscoveredAt`, so they fall under "never probed" and also re-probe.
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

/**
 * Decide whether startup may probe an agent's runtime capabilities on its
 * own, without a Settings or setup action.
 *
 * Probing is otherwise reserved for Settings and setup, so this covers only the
 * case where a user action cannot be expected: an agent PwrAgent already knew
 * whose runtime changed underneath it. Startup discovery drops cached
 * capabilities whenever the CLI version or launch identity changes (an upgrade,
 * or a legacy install giving way to a current one). Nothing refills them, and
 * the composer builds its model and effort pickers only from capabilities.
 *
 * The rule never fires in steady state. It requires that no probe has
 * run for the current runtime, and every probe outcome records one: a result
 * sets `lastDiscoveredAt`, and a failure sets `lastDiscoveryError`. Each
 * runtime is therefore probed at most once, and the next runtime change clears
 * those fields and re-arms it. An agent seen for the first time is left to
 * Settings and setup, which own first discovery.
 *
 * @param agent              The merged record startup discovery just persisted.
 * @param previouslyRecorded Whether a durable record for this agent existed
 *                           before this discovery pass.
 */
export function shouldProbeAcpCapabilitiesAtStartup(
  agent: AcpInstalledAgentRecord,
  previouslyRecorded: boolean,
): boolean {
  return (
    previouslyRecorded
    && agent.installStatus === "installed"
    && agent.launchDescriptor !== undefined
    && agent.runtimeCapabilities === undefined
    && agent.lastDiscoveredAt === undefined
    && agent.lastDiscoveryError === undefined
  );
}

/**
 * The record update for capabilities learned from a live session rather than a
 * probe.
 *
 * A session reply reports that session's own menus. It never re-derives the
 * model catalog — `normalizeAcpRuntimeCapabilities` carries `models` forward
 * from the capabilities the client started with — so it is not a probe result
 * and must not stamp the probe clock. Stamping it keeps a catalog the last
 * probe got wrong permanently fresh for an agent in daily use, because every
 * turn renews the 48-hour window before it can expire: a Kimi record
 * catalogued before #2219 still listed `on` among K3's thought levels, and
 * named it K3's default, a day after the fix shipped.
 *
 * `lastDiscoveryError` is preserved for the same reason. It records what the
 * last probe did, and no session reply can answer for a probe.
 */
export function recordWithSessionRuntimeCapabilities(
  current: AcpInstalledAgentRecord,
  runtimeCapabilities: AcpInstalledAgentRecord["runtimeCapabilities"],
  now: number,
): AcpInstalledAgentRecord {
  return {
    ...current,
    runtimeCapabilities,
    updatedAt: Math.max(current.updatedAt, now),
  };
}
