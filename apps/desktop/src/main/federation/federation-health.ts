import type {
  DesktopFederationMode,
  FederationHealthStatus,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
} from "@pwragent/shared";
import type { RuntimeFederationLeaseSnapshot } from "../runtime-federation-lease";
import type { FederationRuntimeConfig } from "./federation-runtime-config";

export function buildFederationHealthStatus(params: {
  config: Pick<FederationRuntimeConfig, "mode" | "publicUrl">;
  peers: FederationPeerSummary[];
  instanceId?: FederationInstanceId;
  listenUrl?: string;
  unavailableReason?: string;
}): FederationHealthStatus {
  const mode = params.config.mode;
  const enabled = mode !== "disabled";
  const publicUrl = params.config.publicUrl;

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
 * runtime stopped until recovery acquires ownership. The coordinator distinguishes
 * a live holder from a dead owner whose grace period is still running.
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
    navigationQueryProtocol: peer.navigationQueryProtocol,
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
