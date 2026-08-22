import type { RefObject } from "react";
import type { StarMapCameraKey } from "./star-map-keyboard";
import { useKeyboardLayoutLabels } from "./useKeyboardLayoutLabels";

/**
 * The clue that the map flies from the keyboard.
 *
 * A control nobody can see is a control nobody uses, and WASD is not
 * discoverable on a surface that also drags: the operator reaches for the
 * mouse, it works, and the faster gesture is never found. So the keys sit
 * on the map at rest, in the corner the other chrome leaves free.
 *
 * The caps also light up under the keys actually being held. That is not
 * decoration: it is the only feedback that the map is responding to the
 * keyboard rather than to something else, which matters most in the case
 * where a key does nothing because the camera is already parked against
 * its bounds.
 *
 * The pan caps are labelled from the operator's real keyboard layout, not
 * hardcoded to W/A/S/D. The camera binds by physical position, so on AZERTY
 * the correct keys are the ones engraved Z Q S D — drawing "W" there would
 * point at the wrong key while the right one silently worked.
 */
export function StarMapKeyHint(props: {
  held: ReadonlySet<StarMapCameraKey>;
  /**
   * The hint is opaque chrome parked in the bottom-left corner, which is
   * also where an edge arrow for a body off that corner lands. The screen
   * measures this box and hands it to the arrows as an obstacle to slide
   * clear of, so the two no longer stack.
   */
  ref?: RefObject<HTMLDivElement | null>;
}) {
  const labels = useKeyboardLayoutLabels();

  const cap = (key: StarMapCameraKey, label: string, modifier?: string) => (
    <kbd
      className={`star-map__key${
        modifier ? ` star-map__key--${modifier}` : ""
      }${props.held.has(key) ? " is-held" : ""}`}
    >
      {label}
    </kbd>
  );

  return (
    <div
      className="star-map__key-hint"
      ref={props.ref}
      role="note"
      // The caps are a picture of a keyboard; spelling them out one glyph
      // at a time is noise. One sentence carries the whole control set,
      // including the alternates the picture has no room for.
      aria-label={
        `Camera controls: ${labels.KeyW}, ${labels.KeyA}, ${labels.KeyS} and `
        + `${labels.KeyD} or the arrow keys pan the map. Hold Shift to move `
        + "faster. Minus and equals zoom out and in. Zero resets the view."
      }
    >
      <span className="star-map__key-group" aria-hidden="true">
        <span className="star-map__key-pad">
          {cap("up", labels.KeyW, "up")}
          {cap("left", labels.KeyA, "left")}
          {cap("down", labels.KeyS, "down")}
          {cap("right", labels.KeyD, "right")}
        </span>
        <span className="star-map__key-label">pan</span>
      </span>
      <span className="star-map__key-group" aria-hidden="true">
        {cap("zoomOut", "−")}
        {cap("zoomIn", "+")}
        <span className="star-map__key-label">zoom</span>
      </span>
      {/* Shift and 0 were previously in the label only — the two controls
          hardest to guess were the two the picture did not show. */}
      <span className="star-map__key-group" aria-hidden="true">
        <kbd className="star-map__key star-map__key--wide">⇧</kbd>
        <span className="star-map__key-label">faster</span>
      </span>
      <span className="star-map__key-group" aria-hidden="true">
        <kbd className="star-map__key">0</kbd>
        <span className="star-map__key-label">reset</span>
      </span>
    </div>
  );
}
