import { CelestialIcon } from "../../icons";
import { InstanceGlyph } from "../federation/InstanceGlyph";
import type { FederationInstanceChipModel } from "./FederationInstanceChips";

const MAX_BODIES = 8;

/**
 * A static picture of the Star Map: this instance as the sun, every other
 * instance on one orbit, connected ones outlined in the accent. It is a
 * doorway, not a render of the map — the real layout needs the thread feed,
 * which the popover does not load. No motion.
 */
export function FederationStarMapPreview(props: {
  chips: FederationInstanceChipModel[];
  onOpen: () => void;
}) {
  const bodies = props.chips.slice(0, MAX_BODIES);
  const total = props.chips.length + 1;
  return <button type="button" className="federation-sky" aria-label="Open the Star Map" onClick={props.onOpen}>
    <span aria-hidden="true" className="federation-sky__orbit federation-sky__orbit--inner" />
    <span aria-hidden="true" className="federation-sky__orbit federation-sky__orbit--outer" />
    <span aria-hidden="true" className="federation-sky__sun" />
    {bodies.map((chip, index) => {
      // Start at twelve o'clock and go clockwise, so the first few instances
      // land on the top arc, clear of the caption bar.
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(bodies.length, 1);
      const left = 50 + Math.cos(angle) * 33;
      const top = 42 + Math.sin(angle) * 30;
      return <span aria-hidden="true" key={chip.instanceId}
        className={`federation-sky__body${chip.online ? " federation-sky__body--online" : ""}`}
        style={{ left: `${left}%`, top: `${top}%` }}>
        {chip.icon ? <CelestialIcon icon={chip.icon} size={10} /> : <InstanceGlyph instanceId={chip.instanceId} size={10} />}
        <span>{chip.label}</span>
      </span>;
    })}
    <span className="federation-sky__caption">
      <span className="federation-sky__label"><strong>Star Map</strong>
        {` · ${total} ${total === 1 ? "instance" : "instances"}`}</span>
      <span className="federation-sky__cta">Open Star Map ↗</span>
    </span>
  </button>;
}
