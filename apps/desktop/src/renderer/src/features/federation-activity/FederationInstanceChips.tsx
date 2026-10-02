import type {
  CelestialIconId,
  FederationActiveConnection,
  FederationActivitySeries,
  FederationHealthStatus,
} from "@pwragent/shared";
import { formatFederationPeerDisplayLabelParts } from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import { formatTrafficBytes } from "./format-traffic-bytes";
import { federationTransportTag, federationViaLabel, type FederationTransportTag } from "./federation-transport";

export type FederationInstanceChipModel = {
  instanceId: string;
  /** The full `host / profile` when a profile is shown, else the full host: tooltips, sorting. */
  label: string;
  /** The machine part the face draws: the federation's short name when it has one. */
  host: string;
  /** The full machine label, present only when `host` is a short name standing in for it. */
  fullHost?: string;
  /** Present only when another profile on the same machine needs telling apart. */
  profileName?: string;
  icon?: CelestialIconId;
  /** Undefined for an instance the directory knows but nothing reaches. */
  transport?: FederationTransportTag;
  online: boolean;
  connection?: FederationActiveConnection;
};

/**
 * Every instance this one can see, not every socket: a client reaches a
 * dozen peers through one gateway connection, and those are tagged Relay.
 * Ordered online first, then by label, and never by traffic, so a chip does
 * not move under the pointer between two polls.
 */
export function federationInstanceChips(health: FederationHealthStatus): FederationInstanceChipModel[] {
  const serving = health.enabled && !health.leaseHolder;
  const connections = serving ? health.activeConnections ?? [] : [];
  const chips: FederationInstanceChipModel[] = health.peers
    .filter((peer) => peer.id !== health.instanceId)
    .map((peer) => {
      const connection = connections.find((candidate) => candidate.peerId === peer.id);
      const online = serving && (Boolean(connection) || peer.status === "connected");
      const parts = formatFederationPeerDisplayLabelParts(peer, health.peers);
      return {
        instanceId: peer.id,
        label: parts.profileName ? `${parts.label} / ${parts.profileName}` : parts.label,
        host: parts.shortLabel ?? parts.label,
        ...(parts.shortLabel ? { fullHost: parts.label } : {}),
        profileName: parts.profileName,
        icon: peer.celestialIcon,
        transport: connection ? federationTransportTag(connection) : online ? "Relay" : undefined,
        online,
        connection,
      };
    });
  for (const connection of connections) {
    if (chips.some((chip) => chip.instanceId === connection.peerId)) continue;
    chips.push({
      instanceId: connection.peerId,
      label: connection.peerId,
      host: connection.peerId,
      transport: federationTransportTag(connection),
      online: true,
      connection,
    });
  }
  return chips.sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
}

/** The text on a chip's face: the short name, then the profile when one shows. */
export function federationChipFaceLabel(chip: FederationInstanceChipModel): string {
  return chip.profileName ? `${chip.host} / ${chip.profileName}` : chip.host;
}

/**
 * A chip's accessible name. It starts with the face text, so voice control
 * can say what it sees (WCAG 2.5.3), and then names the full machine label
 * a short name stands in for.
 */
export function federationChipName(chip: FederationInstanceChipModel): string {
  const face = federationChipFaceLabel(chip);
  return chip.fullHost ? `${face} (${chip.fullHost})` : face;
}

function connectionLine(connection: FederationActiveConnection): string {
  if (connection.direction === "outgoing") return connection.endpoint ?? "Endpoint unavailable";
  if (connection.via === "cloudflare-tunnel") {
    return connection.reportedClientAddress
      ? `Client ${connection.reportedClientAddress} (reported by Cloudflare)`
      : "Through the Cloudflare Tunnel";
  }
  const via = federationViaLabel(connection.via);
  if (via) return `Through ${via}`;
  return `${connection.remoteAddress ?? "Unknown"} → ${connection.localAddress ?? "Unknown"}`;
}

export function federationChipTooltip(
  chip: FederationInstanceChipModel,
  minute: FederationActivitySeries["windows"]["1m"] | undefined,
  action: string,
): string {
  const head = [chip.label, chip.transport ?? "Offline", chip.connection?.direction].filter(Boolean).join(" · ");
  return [
    head,
    minute ? `↑ ${formatTrafficBytes(minute.sent.wireBytes)} ↓ ${formatTrafficBytes(minute.received.wireBytes)} this minute` : undefined,
    chip.connection ? connectionLine(chip.connection) : undefined,
    action,
  ].filter(Boolean).join("\n");
}

/** Glyph, label, transport tag and offline dot: what every Federation chip shows. */
export function FederationChipFace({ chip }: { chip: FederationInstanceChipModel }) {
  return <>
    {chip.icon ? <CelestialIcon icon={chip.icon} size={12} />
      : <InstanceGlyph instanceId={chip.instanceId} size={12} />}
    <span className="federation-chip__label">{federationChipFaceLabel(chip)}</span>
    {chip.transport ? <span className={`federation-chip__tag federation-chip__tag--${chip.transport.toLowerCase().replace(/ /g, "-")}`}>
      {chip.transport}</span> : null}
    {chip.online ? null : <span className="federation-chip__offline" aria-label="Offline" />}
  </>;
}
