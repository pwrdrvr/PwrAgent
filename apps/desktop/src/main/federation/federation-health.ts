import type {
  DesktopFederationMode,
  DesktopSettingsSnapshot,
  FederationHealthStatus,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
} from "@pwragent/shared";

export function buildFederationHealthStatus(params: {
  settings: DesktopSettingsSnapshot;
  peers: FederationPeerSummary[];
  instanceId?: FederationInstanceId;
}): FederationHealthStatus {
  const mode = params.settings.federation.mode.value;
  const enabled = mode !== "disabled";
  const publicUrl = params.settings.federation.publicUrl.value.trim();

  return {
    enabled,
    role: roleForMode(mode),
    status: enabled ? statusForMode(mode) : "disabled",
    instanceId: params.instanceId,
    listenUrl: enabled ? listenUrlForSettings(params.settings) : undefined,
    publicUrl: publicUrl.length > 0 ? publicUrl : undefined,
    peers: params.peers.map(publicPeerSummary),
  };
}

export function publicPeerSummary(peer: FederationPeerSummary): FederationPeerSummary {
  return {
    id: peer.id,
    label: peer.label,
    role: peer.role,
    status: peer.status,
    capabilities: [...peer.capabilities],
    protocolVersion: peer.protocolVersion,
    endpoint: peer.endpoint,
    profileName: peer.profileName,
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

function statusForMode(mode: DesktopFederationMode): FederationHealthStatus["status"] {
  return mode === "client" ? "connecting" : "listening";
}

function listenUrlForSettings(settings: DesktopSettingsSnapshot): string {
  return `ws://${settings.federation.listenHost.value}:${settings.federation.listenPort.value}`;
}
