import type {
  DesktopFederationMode,
  DesktopSettingsSnapshot,
  FederationHealthStatus,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
} from "@pwragent/shared";
import type { RuntimeFederationLeaseSnapshot } from "../runtime-federation-lease";

export function buildFederationHealthStatus(params: {
  settings: DesktopSettingsSnapshot;
  peers: FederationPeerSummary[];
  instanceId?: FederationInstanceId;
  listenUrl?: string;
  unavailableReason?: string;
}): FederationHealthStatus {
  const mode = params.settings.federation.mode.value;
  const enabled = mode !== "disabled";
  const publicUrl = params.settings.federation.publicUrl.value.trim();

  return {
    enabled,
    role: roleForMode(mode),
    status: enabled
      ? statusForMode(mode, params.listenUrl, params.unavailableReason)
      : "disabled",
    instanceId: params.instanceId,
    listenUrl: enabled ? params.listenUrl : undefined,
    publicUrl: publicUrl.length > 0 ? publicUrl : undefined,
    unavailableReason: enabled ? params.unavailableReason : undefined,
    peers: params.peers.map(publicPeerSummary),
  };
}

/**
 * Overlay the profile lease state onto a health snapshot. Another live
 * instance holding this profile's federation lease keeps this instance's
 * runtime deliberately stopped, and it stays stopped after the holder
 * exits — the lease record (and with it the holder metadata) disappears
 * while the stop reason does not. Surface the reason either way, with the
 * holder's identity only while it is still live.
 */
export function applyFederationLeaseSnapshot(
  health: FederationHealthStatus,
  snapshot: RuntimeFederationLeaseSnapshot | undefined,
): void {
  if (
    !health.enabled
    || !snapshot
    || snapshot.leaseHeld
    || snapshot.disabledReasonKind !== "lease_held"
  ) {
    return;
  }
  health.status = "degraded";
  health.unavailableReason =
    snapshot.disabledReason ?? health.unavailableReason;
  if (snapshot.leaseHolder) {
    health.leaseHolder = snapshot.leaseHolder;
  }
}

export function publicPeerSummary(peer: FederationPeerSummary): FederationPeerSummary {
  return {
    id: peer.id,
    label: peer.label,
    role: peer.role,
    status: peer.status,
    capabilities: [...peer.capabilities],
    canRevoke: peer.canRevoke,
    protocolVersion: peer.protocolVersion,
    endpoint: peer.endpoint,
    profileName: peer.profileName,
    celestialIcon: peer.celestialIcon,
    notes: peer.notes,
    host: peer.host,
    lastConnectedAt: peer.lastConnectedAt,
    lastActivityAt: peer.lastActivityAt,
    revokedAt: peer.revokedAt,
    unavailableReason: peer.unavailableReason,
  };
}

function roleForMode(mode: DesktopFederationMode): FederationInstanceRole {
  switch (mode) {
    case "gateway":
      return "gateway";
    case "dual":
      return "dual";
    case "client":
    case "disabled":
      return "client";
  }
}

function statusForMode(
  mode: DesktopFederationMode,
  listenUrl: string | undefined,
  unavailableReason: string | undefined,
): FederationHealthStatus["status"] {
  if (unavailableReason) {
    return "degraded";
  }
  if (mode === "client") {
    return "connecting";
  }
  return listenUrl ? "listening" : "connecting";
}
