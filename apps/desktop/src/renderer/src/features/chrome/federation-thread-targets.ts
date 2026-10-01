import {
  formatFederationPeerDisplayLabel,
  type CelestialIconId,
  type FederationCapability,
  type FederationHealthStatus,
} from "@pwragent/shared";

/**
 * Capabilities a peer must advertise before this window can start a thread on
 * it. `thread_navigation` supplies the peer-owned project picker,
 * `launchpad_metadata` answers the `ensureDirectoryLaunchpad` that opens the
 * composer, and `environment_actions` covers the environment/script work the
 * launchpad runs once composition begins. A remote viewer window is
 * deliberately not part of this flow: the resulting remote thread is mounted
 * in the current window.
 */
const REQUIRED_TARGET_CAPABILITIES: readonly FederationCapability[] = [
  "thread_navigation",
  "launchpad_metadata",
  "environment_actions",
];

/**
 * Why a target can or cannot host a new thread right now.
 *
 * `offline` is a state the peer recovers from on its own, so the row stays
 * visible and explains itself. `unsupported` is a property of the build the
 * peer is running and will not change without an upgrade — it stays visible
 * for the same reason Settings → Federation keeps listing the peer with a
 * disabled "Browse remote threads": a machine vanishing from the list is
 * indistinguishable from a bug.
 */
export type FederationThreadTargetAvailability =
  | "available"
  | "offline"
  | "unsupported";

export type FederationThreadTarget =
  FederationPeerTarget<FederationThreadTargetAvailability>;

function resolveAvailability(
  peer: FederationHealthStatus["peers"][number],
): FederationThreadTargetAvailability {
  if (
    !REQUIRED_TARGET_CAPABILITIES.every((capability) =>
      peer.capabilities.includes(capability),
    )
  ) {
    return "unsupported";
  }
  return peer.status === "connected" ? "available" : "offline";
}

/** A peer offered as the destination of a thread action, with its state. */
export type FederationPeerTarget<Availability extends string> = {
  instanceId: string;
  label: string;
  availability: Availability;
  /** The peer's assigned identity mark, as its thread rows draw it. */
  celestialIcon?: CelestialIconId;
};

/**
 * Federation peers as thread-action targets, in a stable display order, with
 * each caller's own availability rule.
 *
 * Sorted by label rather than left in health order: these rows live in
 * hover-opened menus and dialogs, health re-reads on every peer transition,
 * and a list that reorders under the pointer turns a misclick into a thread
 * sent to the wrong machine.
 *
 * Revoked peers are dropped — they are dead entries, not offline ones. They
 * are still passed to `formatFederationPeerDisplayLabel`, but only because it
 * filters them out itself; what the local instance's presence in that list
 * buys us is a peer sharing THIS machine's label keeping its profile suffix.
 */
export function buildFederationPeerTargets<Availability extends string>(
  health: FederationHealthStatus | undefined,
  resolve: (peer: FederationHealthStatus["peers"][number]) => Availability,
  excludedInstanceId?: string,
): FederationPeerTarget<Availability>[] {
  if (!health) {
    return [];
  }
  const visibleInstances = [
    ...health.peers,
    ...(health.localLabel
      ? [{ label: health.localLabel, profileName: health.localProfileName }]
      : []),
  ];
  return health.peers
    .filter(
      (peer) =>
        !peer.revokedAt
        && peer.id !== excludedInstanceId,
    )
    .map((peer) => ({
      instanceId: peer.id,
      label: formatFederationPeerDisplayLabel(peer, visibleInstances),
      availability: resolve(peer),
      ...(peer.celestialIcon ? { celestialIcon: peer.celestialIcon } : {}),
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label)
        // Two peers can share a display label — same machine, neither
        // advertising a profile. Without a tiebreak their order falls back to
        // health order, which is exactly the under-the-pointer reshuffle this
        // sort exists to prevent.
        || left.instanceId.localeCompare(right.instanceId),
    );
}

/**
 * Federation peers this window can offer as a launch target.
 *
 * A remote viewer already creates its context-default thread on the instance
 * the window represents, so that instance is excluded from the separate
 * "New chat on" choices instead of being offered twice.
 */
export function buildFederationThreadTargets(
  health: FederationHealthStatus | undefined,
  currentWindowInstanceId?: string,
): FederationThreadTarget[] {
  return buildFederationPeerTargets(health, resolveAvailability, currentWindowInstanceId);
}

/**
 * The project-check states every machine list shows: the New Thread flyout,
 * the composer's machine chip and the sub-thread flyout. One copy, so the
 * three cannot drift apart.
 */
export const FEDERATION_PROJECT_STATE_LABEL = {
  checking: "Checking…",
  missing: "No project",
} as const;

/** The short state a target row shows beside its label when unavailable. */
export const FEDERATION_TARGET_AVAILABILITY_LABEL: Partial<
  Record<FederationThreadTargetAvailability, string>
> = {
  offline: "Offline",
  unsupported: "Unsupported",
};

/** Tooltip/title text explaining a row the operator cannot click. */
export function describeFederationThreadTargetAvailability(
  availability: FederationThreadTargetAvailability,
): string | undefined {
  if (availability === "offline") {
    return "Not connected";
  }
  if (availability === "unsupported") {
    return "This instance's build cannot host a new thread";
  }
  return undefined;
}
