import type { StarMapCameraKey } from "./star-map-keyboard";

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
 */
export function StarMapKeyHint(props: { held: ReadonlySet<StarMapCameraKey> }) {
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
      role="note"
      // The caps are a picture of a keyboard; spelling them out one glyph
      // at a time is noise. One sentence carries the whole control set,
      // including the alternates the picture has no room for.
      aria-label={
        "Camera controls: W, A, S and D or the arrow keys pan the map. "
        + "Hold Shift to move faster. Minus and equals zoom out and in. "
        + "Zero resets the view."
      }
    >
      <span className="star-map__key-group" aria-hidden="true">
        <span className="star-map__key-pad">
          {cap("up", "W", "up")}
          {cap("left", "A", "left")}
          {cap("down", "S", "down")}
          {cap("right", "D", "right")}
        </span>
        <span className="star-map__key-label">pan</span>
      </span>
      <span className="star-map__key-group" aria-hidden="true">
        {cap("zoomOut", "−")}
        {cap("zoomIn", "+")}
        <span className="star-map__key-label">zoom</span>
      </span>
    </div>
  );
}
