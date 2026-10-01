import {
  formatFederationPeerDisplayLabel,
  type CelestialIconId,
  type FederationCapability,
  type FederationHealthStatus,
} from "@pwragent/shared";

/**
 * Capabilities a receiver must advertise before main will send it a thread.
 * Mirrors the `assertTarget` check in the federation runtime, so a machine
 * this list offers is one the backend accepts.
 */
const REQUIRED_RECEIVER_CAPABILITIES: readonly FederationCapability[] = [
  "thread_handoff",
  "turn_control",
  "environment_actions",
  "file_push",
];

/**
 * Why a peer can or cannot receive a thread right now.
 *
 * `incoming-off` is the receiver's own **Allow file push** preference: the
 * package travels as a pushed file, so a receiver that refuses files refuses
 * the transfer. It is listed separately from `update-required` because the
 * fix is a setting on that machine, not a new build.
 */
export type ThreadHandoffTargetAvailability =
  | "available"
  | "offline"
  | "update-required"
  | "incoming-off";

export type ThreadHandoffTarget = {
  instanceId: string;
  label: string;
  availability: ThreadHandoffTargetAvailability;
  celestialIcon?: CelestialIconId;
};

function resolveAvailability(
  peer: FederationHealthStatus["peers"][number],
): ThreadHandoffTargetAvailability {
  if (
    !REQUIRED_RECEIVER_CAPABILITIES.every((capability) =>
      peer.capabilities.includes(capability),
    )
  ) {
    return "update-required";
  }
  if (peer.status !== "connected") {
    return "offline";
  }
  return peer.receiverPermissions?.filePush === true ? "available" : "incoming-off";
}

/**
 * Every peer this window could send a thread to, in the stable label order
 * the "New chat on" targets use. Unavailable peers stay listed with their
 * reason: a machine missing from the list is indistinguishable from a bug.
 * Revoked peers are dead entries and are dropped.
 */
export function buildThreadHandoffTargets(
  health: FederationHealthStatus | undefined,
): ThreadHandoffTarget[] {
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
    .filter((peer) => !peer.revokedAt && peer.id !== health.instanceId)
    .map((peer) => ({
      instanceId: peer.id,
      label: formatFederationPeerDisplayLabel(peer, visibleInstances),
      availability: resolveAvailability(peer),
      ...(peer.celestialIcon ? { celestialIcon: peer.celestialIcon } : {}),
    }))
    .sort(
      (left, right) =>
        left.label.localeCompare(right.label)
        || left.instanceId.localeCompare(right.instanceId),
    );
}

/** The short state an unavailable target row shows beside its label. */
export const THREAD_HANDOFF_TARGET_STATE_LABEL: Partial<
  Record<ThreadHandoffTargetAvailability, string>
> = {
  offline: "Offline",
  "update-required": "Update required",
  "incoming-off": "Incoming files off",
};

/** Tooltip text explaining a target row the operator cannot pick. */
export function describeThreadHandoffTargetAvailability(
  target: ThreadHandoffTarget,
): string | undefined {
  switch (target.availability) {
    case "offline":
      return `${target.label} is not connected`;
    case "update-required":
      return `Update PwrAgent on ${target.label} to receive threads`;
    case "incoming-off":
      return `Turn on Allow file push in Settings › Federation on ${target.label}`;
    default:
      return undefined;
  }
}
