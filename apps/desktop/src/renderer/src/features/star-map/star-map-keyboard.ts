/**
 * Keyboard camera for the star map.
 *
 * The map is a surface you fly over rather than a document you scroll, so
 * it moves the way a PC game moves: WASD (and the arrows, for the people
 * who never took to WASD) drive the camera, `-` / `=` work the zoom under
 * the right hand, and both run *continuously* while the key is held rather
 * than in discrete hops. A per-keypress nudge is what a form does; holding
 * a direction and watching the field slide past is what a map does.
 *
 * Everything here is pure: the hook owns the timing and the DOM, this owns
 * the rules. Speeds are in screen pixels per second, deliberately NOT in
 * canvas units — panning has to feel identical at every zoom, exactly as
 * the pointer drag does, and `view.x` / `view.y` are already screen-pixel
 * translates.
 */

import {
  clampStarMapView,
  MAX_ZOOM,
  MIN_ZOOM,
  type StarMapView,
  type StarMapViewBox,
} from "./star-map-view-geometry";

/** One direction the camera can be flying in. */
export type StarMapCameraKey =
  | "up"
  | "down"
  | "left"
  | "right"
  | "zoomIn"
  | "zoomOut";

/**
 * Cruise speed, in screen pixels per second.
 *
 * Sized so a press-and-release crosses a useful distance without
 * overshooting the map, and a held key crosses a 1280px window in about a
 * second — fast enough to feel like flying, slow enough to stop on a card.
 */
export const STAR_MAP_PAN_SPEED = 1200;

/** Shift is sprint, the way it is in every game that has a run button. */
export const STAR_MAP_PAN_SPRINT = 2.5;

/**
 * Zoom rate in octaves (doublings) per second. The full MIN_ZOOM..MAX_ZOOM
 * range is about 2.5 octaves, so a held key sweeps the whole range in
 * roughly 1.8s. Exponential rather than linear because zoom is perceived
 * multiplicatively: a flat `scale += k` crawls when zoomed out and lurches
 * when zoomed in.
 */
export const STAR_MAP_ZOOM_OCTAVES_PER_SEC = 1.4;

/**
 * Longest frame the camera will integrate in one step.
 *
 * A backgrounded window delivers its next animation frame seconds after
 * the last one. Without this cap that gap integrates in a single step and
 * the map teleports to its clamp the instant the operator comes back.
 */
export const STAR_MAP_MAX_FRAME_MS = 100;

/**
 * Physical key positions, by `KeyboardEvent.code`.
 *
 * `code` names the key's POSITION on the board, not the character it
 * produces, and that distinction is the whole point here. `event.key` for
 * the physical W is "w" on QWERTY but "z" on AZERTY and "," on Dvorak, so a
 * key-based binding silently locks every non-QWERTY operator out of the
 * headline control — and the on-screen hint draws an inverted-T, which is a
 * claim about position that only `code` can honour. Games bind movement by
 * position for exactly this reason.
 *
 * Zoom sits on `-` and `=` because that is the near-universal keyboard zoom
 * pair, numpad included. Deliberately not Page Up / Page Down: those read
 * as "pan by a page" at least as often as they read as zoom, and a wrong
 * guess on a movement key is worse than an absent one.
 */
const CAMERA_BY_CODE: Readonly<Record<string, StarMapCameraKey>> = {
  KeyW: "up",
  KeyS: "down",
  KeyA: "left",
  KeyD: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Equal: "zoomIn",
  NumpadAdd: "zoomIn",
  Minus: "zoomOut",
  NumpadSubtract: "zoomOut",
};

/**
 * Character fallback, used ONLY when an event carries no `code`.
 *
 * Synthetic events (including a good deal of test tooling) often set `key`
 * alone. Falling back on an event that HAS a `code` we do not recognise
 * would undo the layout fix — on AZERTY the physical Z reports `key: "w"`,
 * and we must not pan for it.
 */
const CAMERA_BY_KEY: Readonly<Record<string, StarMapCameraKey>> = {
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  "=": "zoomIn",
  "+": "zoomIn",
  "-": "zoomOut",
  _: "zoomOut",
};

/** The shape this module needs from a keyboard event. */
export type StarMapKeyStroke = { key: string; code?: string };

/**
 * Which camera direction a keystroke drives, or `undefined` for a key the
 * map does not fly with.
 */
export function resolveStarMapCameraKey(
  stroke: StarMapKeyStroke,
): StarMapCameraKey | undefined {
  if (stroke.code) return CAMERA_BY_CODE[stroke.code];
  const key = stroke.key.length === 1 ? stroke.key.toLowerCase() : stroke.key;
  return CAMERA_BY_KEY[key];
}

/**
 * `0` puts the map back where it opens — the same key every design tool and
 * browser uses for "back to 100%", and the keyboard's way in to the "Reset
 * view" action already in the View popover. Digit row and numpad both; `0`
 * is unshifted on every layout we bind, so the character fallback is safe.
 */
export function isStarMapResetViewKey(stroke: StarMapKeyStroke): boolean {
  if (stroke.code) return stroke.code === "Digit0" || stroke.code === "Numpad0";
  return stroke.key === "0";
}

/**
 * Whether a key event aimed at this element should be left alone.
 *
 * The map layer hosts real text entry — chat card composers, and any input
 * a card grows later — so `w` typed into one must reach the composer, not
 * fly the camera. Chat cards are objects IN the galaxy now rather than
 * windows over it, which changes nothing here: what matters is that the
 * keystroke was aimed at text, not where the text is anchored.
 */
export function isStarMapTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return Boolean(
    target.closest(
      "input, textarea, select, [contenteditable], [role='dialog'], .star-map-chat-card",
    ),
  );
}

/**
 * Advance the camera by one frame.
 *
 * Pan is applied first and zoom second, about the centre of the window —
 * the keyboard has no pointer to zoom about, and the centre is the only
 * fixed point the operator can predict. Clamped through the same
 * `clampStarMapView` every other operator-driven write goes through, so a
 * held key parks against the bounds instead of flying the map away.
 */
export function stepStarMapCamera(params: {
  view: StarMapView;
  held: ReadonlySet<StarMapCameraKey>;
  elapsedMs: number;
  /** Shift held: sprint. */
  sprint: boolean;
  /** Untransformed canvas size for the current lens. */
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
}): StarMapView {
  const seconds =
    Math.min(Math.max(params.elapsedMs, 0), STAR_MAP_MAX_FRAME_MS) / 1000;
  if (seconds === 0 || params.held.size === 0) return params.view;

  let x = params.view.x;
  let y = params.view.y;

  // Diagonals are normalised, or holding two directions would travel a
  // factor of sqrt(2) faster than holding one.
  let dx = (params.held.has("right") ? 1 : 0) - (params.held.has("left") ? 1 : 0);
  let dy = (params.held.has("down") ? 1 : 0) - (params.held.has("up") ? 1 : 0);
  const length = Math.hypot(dx, dy);
  if (length > 0) {
    dx /= length;
    dy /= length;
    const distance =
      STAR_MAP_PAN_SPEED * seconds * (params.sprint ? STAR_MAP_PAN_SPRINT : 1);
    // The camera moves one way, so the canvas under it moves the other.
    x -= dx * distance;
    y -= dy * distance;
  }

  const zoomDirection =
    (params.held.has("zoomIn") ? 1 : 0) - (params.held.has("zoomOut") ? 1 : 0);
  let scale = params.view.scale;
  if (zoomDirection !== 0 && scale > 0) {
    const next = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        scale * 2 ** (STAR_MAP_ZOOM_OCTAVES_PER_SEC * seconds * zoomDirection),
      ),
    );
    // Ratio comes off the CLAMPED scale, so a key held at either end of
    // the range stops moving the canvas instead of drifting it sideways.
    const ratio = next / scale;
    const centerX = params.viewport.width / 2;
    const centerY = params.viewport.height / 2;
    x = centerX - (centerX - x) * ratio;
    y = centerY - (centerY - y) * ratio;
    scale = next;
  }

  return clampStarMapView({
    view: { x, y, scale },
    canvas: params.canvas,
    viewport: params.viewport,
  });
}
