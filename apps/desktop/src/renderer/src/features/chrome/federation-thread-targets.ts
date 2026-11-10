import {
  formatFederationPeerDisplayLabel,
  type CelestialIconId,
  type FederationCapability,
  type FederationHealthStatus,
} from "@pwragent/shared";
import { federationDisplayLabel } from "../../lib/federation-display-label";

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
 * `offline` peers are left out of machine pickers by
 * `listedFederationPeerTargets`; lookups that name a thread's machine still
 * see them. `unsupported` is a property of the build a connected peer is
 * running and will not change without an upgrade, so that row stays listed
 * and says so.
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
  // Offline wins: a disconnected peer's capability list is whatever it last
  // advertised, and calling it "Unsupported" sent operators to upgrade a
  // machine that was only asleep.
  if (peer.status !== "connected") {
    return "offline";
  }
  return REQUIRED_TARGET_CAPABILITIES.every((capability) =>
    peer.capabilities.includes(capability),
  )
    ? "available"
    : "unsupported";
}

/** A peer offered as the destination of a thread action, with its state. */
export type FederationPeerTarget<Availability extends string> = {
  instanceId: string;
  label: string;
  /** Short machine name and profile for controls; `label` retains the full identity. */
  shortLabel?: string;
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
      ...(peer.shortLabel ? { shortLabel: federationDisplayLabel(peer, visibleInstances) } : {}),
      availability: resolve(peer),
      ...(peer.celestialIcon ? { celestialIcon: peer.celestialIcon } : {}),
    }))
    .sort(
      (left, right) =>
        // The name the row shows, as Profiles → Remote Instances sorts
        // (`orderPeersForMenu`). Sorting by the full host label while showing
        // the short name made the list read as shuffled.
        (left.shortLabel ?? left.label).localeCompare(right.shortLabel ?? right.label)
        || left.label.localeCompare(right.label)
        // Two peers can share a display label — same machine, neither
        // advertising a profile. Without a tiebreak their order falls back to
        // health order, which is exactly the under-the-pointer reshuffle this
        // sort exists to prevent.
        || left.instanceId.localeCompare(right.instanceId),
    );
}

/**
 * The peers a machine picker lists: connected ones only, as Profiles →
 * Remote Instances lists them. An offline machine cannot take the action,
 * and ten greyed rows around the one that can made the pickers hard to
 * read. A connected peer that cannot take this action stays listed with its
 * reason, because that reason is about this action, not the machine.
 *
 * `keepInstanceId` is the machine already chosen, kept even while offline so
 * the list agrees with the chip or row that names it.
 *
 * The Star Map, the Federation popover and Settings → Federation describe the
 * federation itself and still show every peer.
 */
export function listedFederationPeerTargets<
  Target extends { instanceId: string; availability: string },
>(targets: readonly Target[], keepInstanceId?: string): Target[] {
  return targets.filter((target) =>
    target.availability !== "offline" || target.instanceId === keepInstanceId);
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
