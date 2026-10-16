import { PinIcon } from "../../icons";

/**
 * The ghost Keep at top slot a pin drag offers, shared by a Directories
 * project and the Pinned group. The boundary carries the list role so the
 * slot is a valid child of its rows' list; it grows to hold the slot only
 * while a drag is live, and only a drop inside the slot's own box keeps.
 */
export function KeepAtTopSlot(props: { label: string }) {
  return (
    <div className="directory-row__pin-drop-boundary" role="listitem">
      <div
        aria-label={props.label}
        aria-hidden="true"
        className="directory-row__keep-top-slot"
        role="separator"
      >
        <PinIcon size={12} />
        Keep at top
      </div>
    </div>
  );
}
