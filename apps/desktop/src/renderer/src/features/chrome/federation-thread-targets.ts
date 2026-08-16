import {
  formatFederationPeerDisplayLabel,
  type FederationCapability,
  type FederationHealthStatus,
} from "@pwragent/shared";

/**
 * Capabilities a peer must advertise before this window can start a thread on
 * it. `remote_window` opens the scoped window, `thread_navigation` lets that
 * window reach its own launchpad, and `environment_actions` covers the
 * environment/script work the launchpad runs once composition begins.
 */
const REQUIRED_TARGET_CAPABILITIES: readonly FederationCapability[] = [
  "remote_window",
  "thread_navigation",
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

export type FederationThreadTarget = {
  instanceId: string;
  label: string;
  availability: FederationThreadTargetAvailability;
};

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

/**
 * Federation peers this window can offer as a launch target, in a stable
 * display order.
 *
 * Sorted by label rather than left in health order: these rows live in
 * hover-opened menus, health re-reads on every peer transition, and a list
 * that reorders under the pointer turns a misclick into a thread created on
 * the wrong machine.
 *
 * A remote viewer already creates its context-default thread on the instance
 * the window represents, so that instance is excluded from the separate
 * "New chat on" choices instead of being offered twice.
 *
 * Revoked peers are dropped — they are dead entries, not offline ones. They
 * are still passed to `formatFederationPeerDisplayLabel`, but only because it
 * filters them out itself; what the local instance's presence in that list
 * buys us is a peer sharing THIS machine's label keeping its profile suffix.
 */
export function buildFederationThreadTargets(
  health: FederationHealthStatus | undefined,
  currentWindowInstanceId?: string,
): FederationThreadTarget[] {
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
        && peer.id !== currentWindowInstanceId,
    )
    .map((peer) => ({
      instanceId: peer.id,
      label: formatFederationPeerDisplayLabel(peer, visibleInstances),
      availability: resolveAvailability(peer),
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
