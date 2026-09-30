import type { FederationActivitySeries, FederationHealthStatus } from "@pwragent/shared";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import {
  FederationChipFace,
  federationChipTooltip,
  federationInstanceChips,
  type FederationInstanceChipModel,
} from "./FederationInstanceChips";

type PeerSeries = { peerId: string; series: FederationActivitySeries };

/**
 * The popover's instance chips, reused as the Activity window's peer filter.
 * Only peers with a series in the current view get a chip; one the directory
 * does not name (the attribution-limit bucket) keeps its series id as label.
 */
export function federationPeerFilterChips(
  health: FederationHealthStatus,
  peers: PeerSeries[],
): FederationInstanceChipModel[] {
  const known = federationInstanceChips(health).filter((chip) =>
    peers.some((peer) => peer.peerId === chip.instanceId));
  const unnamed = peers.filter((peer) => !known.some((chip) => chip.instanceId === peer.peerId))
    .map((peer): FederationInstanceChipModel => ({ instanceId: peer.peerId, label: peer.peerId, online: true }));
  return [...known, ...unnamed];
}

export function FederationPeerFilter(props: {
  chips: FederationInstanceChipModel[];
  peers: PeerSeries[];
  selected: string;
  /** Physical attribution has an aggregate; logical needs one endpoint. */
  allowAll: boolean;
  onSelect: (peerId: string) => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  return <div className="federation-chips federation-activity__peers" role="group" aria-label="Peer">
    {props.allowAll ? <button type="button" className="federation-chip federation-chip--all"
      aria-pressed={props.selected === ""} onClick={() => props.onSelect("")}>
      All connections{props.chips.length ? ` · ${props.chips.length}` : ""}
    </button> : null}
    {props.chips.map((chip) => {
      const minute = props.peers.find((peer) => peer.peerId === chip.instanceId)?.series.windows["1m"];
      const text = federationChipTooltip(chip, minute, "Click to show only this instance");
      return <button type="button" key={chip.instanceId}
        className={`federation-chip${chip.online ? "" : " federation-chip--offline"}`}
        aria-label={chip.label} aria-pressed={props.selected === chip.instanceId}
        aria-describedby={tooltip.visible ? tooltip.tooltipId : undefined}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, text)}
        onFocus={(event) => tooltip.show(event.currentTarget, text)}
        onMouseLeave={tooltip.hide}
        onBlur={tooltip.hide}
        onClick={() => props.onSelect(chip.instanceId)}>
        <FederationChipFace chip={chip} />
      </button>;
    })}
    {tooltip.tooltipNode}
  </div>;
}
