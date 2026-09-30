import type {
  CelestialIconId,
  FederationActiveConnection,
  FederationActivitySeries,
  FederationHealthStatus,
} from "@pwragent/shared";
import { formatFederationPeerDisplayLabel } from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import { formatTrafficBytes } from "./format-traffic-bytes";
import { federationTransportTag, federationViaLabel, type FederationTransportTag } from "./federation-transport";

export type FederationInstanceChipModel = {
  instanceId: string;
  label: string;
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
      return {
        instanceId: peer.id,
        label: formatFederationPeerDisplayLabel(peer, health.peers),
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
      transport: federationTransportTag(connection),
      online: true,
      connection,
    });
  }
  return chips.sort((a, b) => Number(b.online) - Number(a.online) || a.label.localeCompare(b.label));
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
    <span className="federation-chip__label">{chip.label}</span>
    {chip.transport ? <span className={`federation-chip__tag federation-chip__tag--${chip.transport.toLowerCase().replace(/ /g, "-")}`}>
      {chip.transport}</span> : null}
    {chip.online ? null : <span className="federation-chip__offline" aria-label="Offline" />}
  </>;
}

export function FederationInstanceChips(props: {
  chips: FederationInstanceChipModel[];
  /** Per-peer physical series, for the tooltip's minute of traffic. */
  peerSeries?: Array<{ peerId: string; series: FederationActivitySeries }>;
  maxVisible?: number;
  onOpenInstance: (instanceId: string) => void;
  onOpenMore: () => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const maxVisible = props.maxVisible ?? 8;
  const visible = props.chips.length > maxVisible ? props.chips.slice(0, maxVisible - 1) : props.chips;
  const hidden = props.chips.length - visible.length;
  return <div className="federation-chips" role="list" aria-label="Federation instances">
    {visible.map((chip) => {
      const minute = props.peerSeries?.find((peer) => peer.peerId === chip.instanceId)?.series.windows["1m"];
      const text = federationChipTooltip(chip, minute, "Click to open on the Star Map");
      return <div role="listitem" key={chip.instanceId}>
        <button type="button"
          className={`federation-chip${chip.online ? "" : " federation-chip--offline"}`}
          aria-label={`Open ${chip.label} on the Star Map`}
          aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
          onMouseEnter={(event) => tooltip.show(event.currentTarget, text)}
          onFocus={(event) => tooltip.show(event.currentTarget, text)}
          onMouseLeave={tooltip.hide}
          onBlur={tooltip.hide}
          onClick={() => { tooltip.hide(); props.onOpenInstance(chip.instanceId); }}>
          <FederationChipFace chip={chip} />
        </button>
      </div>;
    })}
    {hidden > 0 ? <div role="listitem">
      <button type="button" className="federation-chip federation-chip--more"
        aria-label={`${hidden} more instances; open the Star Map`}
        onClick={props.onOpenMore}>+{hidden} more</button>
    </div> : null}
    {tooltip.tooltipNode}
  </div>;
}
