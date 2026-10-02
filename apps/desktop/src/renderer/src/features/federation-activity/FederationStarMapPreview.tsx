import type { FederationActivitySeries } from "@pwragent/shared";
import type { FocusEvent, MouseEvent } from "react";
import { CelestialIcon } from "../../icons";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import { federationChipName, federationChipTooltip, type FederationInstanceChipModel } from "./FederationInstanceChips";
import { federationTransportShortTag } from "./federation-transport";

/**
 * Eight places around the sun, clockwise from twelve: the right column top
 * to bottom, then the left column bottom to top. Columns, not an ellipse: on
 * the ellipse a 120px body met both neighbours at six o'clock, while the
 * columns keep a 150px body clear of its neighbours and of the sun. Rows one
 * and four sit nearer the middle so the set still reads as an orbit. Rows
 * are 32px apart, which keeps the 20px-tall bodies outside each other's 24px
 * target-size circle.
 */
const SLOTS: ReadonlyArray<{ left: string; top: string }> = [
  { left: "72%", top: "22px" },
  { left: "79%", top: "54px" },
  { left: "79%", top: "86px" },
  { left: "72%", top: "118px" },
  { left: "28%", top: "118px" },
  { left: "21%", top: "86px" },
  { left: "21%", top: "54px" },
  { left: "28%", top: "22px" },
];

/**
 * A static picture of the Star Map that is also the popover's instance list:
 * this instance as the sun, every other instance as a body that opens the
 * Star Map at that instance. Connected bodies are outlined in the accent; a
 * body this instance reaches directly carries its transport. It is a doorway,
 * not a render of the map: the real layout needs the thread feed, which the
 * popover does not load. No motion.
 */
export function FederationStarMapPreview(props: {
  chips: FederationInstanceChipModel[];
  /** Per-peer physical series, for each body's minute of traffic. */
  peerSeries?: Array<{ peerId: string; series: FederationActivitySeries }>;
  onOpen: () => void;
  onOpenInstance: (instanceId: string) => void;
}) {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  // Past eight, the last place says how many it stands for. Chips arrive
  // online first, so a connected instance always gets a place of its own.
  const bodies = props.chips.length > SLOTS.length ? props.chips.slice(0, SLOTS.length - 1) : props.chips;
  const hidden = props.chips.slice(bodies.length);
  const shown = bodies.length + (hidden.length ? 1 : 0);
  // Fewer than eight spread over the places instead of bunching clockwise.
  const place = (index: number) => SLOTS[shown >= SLOTS.length ? index : Math.floor((index * SLOTS.length) / shown)];
  const total = props.chips.length + 1;
  const online = props.chips.filter((chip) => chip.online).length;
  const describe = (text: string) => ({
    "aria-describedby": tooltip.visible ? tooltip.tooltipId : undefined,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => tooltip.show(event.currentTarget, text),
    onFocus: (event: FocusEvent<HTMLElement>) => tooltip.show(event.currentTarget, text),
    onMouseLeave: tooltip.hide,
    onBlur: tooltip.hide,
  });
  // The tooltip renders beside the group, not in it: a portal's events
  // bubble through the React tree, and the group opens the map on a click.
  return <>
    <div role="group" aria-label="Star Map" className="federation-sky"
      onClick={(event) => {
        // Empty sky opens the map for a pointer. The keyboard has the button.
        if (!(event.target as Element).closest("button")) props.onOpen();
      }}>
      <span aria-hidden="true" className="federation-sky__orbit federation-sky__orbit--inner" />
      <span aria-hidden="true" className="federation-sky__orbit federation-sky__orbit--outer" />
      <span aria-hidden="true" className="federation-sky__sun" />
      {bodies.map((chip, index) => {
        const minute = props.peerSeries?.find((peer) => peer.peerId === chip.instanceId)?.series.windows["1m"];
        // Relay is how everything a client sees arrives, so it says nothing.
        const tag = chip.connection && chip.transport ? chip.transport : undefined;
        return <button type="button" key={chip.instanceId}
          className={`federation-sky__body${chip.online ? " federation-sky__body--online" : ""}`}
          style={place(index)}
          aria-label={`Open ${federationChipName(chip)} on the Star Map`}
          {...describe(federationChipTooltip(chip, minute, "Click to open on the Star Map"))}
          onClick={() => { tooltip.hide(); props.onOpenInstance(chip.instanceId); }}>
          {chip.icon ? <CelestialIcon icon={chip.icon} size={10} /> : <InstanceGlyph instanceId={chip.instanceId} size={10} />}
          <span className="federation-sky__host">{chip.host}</span>
          {chip.profileName ? <span className="federation-sky__profile">{chip.profileName}</span> : null}
          {tag ? <span className={`federation-chip__tag federation-chip__tag--${tag.toLowerCase().replace(/ /g, "-")}`}>
            {federationTransportShortTag(tag)}</span> : null}
          {chip.online ? null : <span aria-hidden="true" className="federation-chip__offline" />}
        </button>;
      })}
      {hidden.length ? <button type="button" className="federation-sky__body federation-sky__body--more"
        style={place(bodies.length)}
        aria-label={`${hidden.length} more instances; open the Star Map`}
        {...describe(hidden.map((chip) => chip.label).join("\n"))}
        onClick={() => { tooltip.hide(); props.onOpen(); }}>
        +{hidden.length} more
      </button> : null}
      {props.chips.length ? null : <span className="federation-sky__alone">No other instances yet</span>}
      <span className="federation-sky__caption">
        <span className="federation-sky__label"><strong>Star Map</strong>
          {` · ${total} ${total === 1 ? "instance" : "instances"}`}
          {props.chips.length ? ` · ${online || "none"} connected` : null}</span>
        {/* Not "Open Star Map": that is the header trigger's name, and a
            spoken or substring match on it must not land here instead. */}
        <button type="button" className="federation-sky__cta" onClick={props.onOpen}>
          Open the Star Map <span aria-hidden="true">↗</span>
        </button>
      </span>
    </div>
    {tooltip.tooltipNode}
  </>;
}
