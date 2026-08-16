import { useEffect, useRef, useState, type RefObject } from "react";
import {
  isStarMapResetViewKey,
  isStarMapTypingTarget,
  resolveStarMapCameraKey,
  stepStarMapCamera,
  type StarMapCameraKey,
} from "./star-map-keyboard";
import type { StarMapView, StarMapViewBox } from "./star-map-view-geometry";

const NO_KEYS: ReadonlySet<StarMapCameraKey> = new Set();

/**
 * Fly the map's camera from the keyboard.
 *
 * Held keys are integrated on an animation frame and written straight onto
 * the canvas element's transform, committing to React state only when the
 * last key comes up — the same shape as the pointer drag in StarMapScreen,
 * and for the same reason: a `setView` per frame re-renders every card on
 * the map sixty times a second to move one transform.
 *
 * Returns the currently-held directions so the on-screen key hint can light
 * up under the operator's fingers. That set changes on keydown/keyup only,
 * never per frame, so it costs one render per press rather than per frame.
 */
export function useStarMapCameraKeys(params: {
  /** Keydown is scoped here, so the map only flies while it has focus. */
  layerRef: RefObject<HTMLElement | null>;
  /** The transformed canvas, written directly during flight. */
  /**
   * Where the view is right now, shared with every other writer. The
   * keyboard camera does NOT keep a private copy: a pinch or a `0` landing
   * mid-flight has to compose with the flight rather than be discarded by
   * it.
   */
  liveViewRef: RefObject<StarMapView>;
  /** Untransformed canvas size for the current lens. */
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
  /** Move the view for one frame, without telling React. */
  onPaint: (next: StarMapView) => void;
  /** Commit the flown-to view once the keys are released. */
  onCommit: (next: StarMapView) => void;
  /** First press claims the view for the operator, as a drag does. */
  onMoveStart: () => void;
  /** `0`: back to where the map opens. */
  onResetView: () => void;
}): ReadonlySet<StarMapCameraKey> {
  const [held, setHeld] = useState<ReadonlySet<StarMapCameraKey>>(NO_KEYS);
  const heldRef = useRef<ReadonlySet<StarMapCameraKey>>(NO_KEYS);
  const sprintRef = useRef(false);
  const flyingRef = useRef(false);

  /**
   * Everything the loop reads that is not the held keys lives in refs, so
   * the listener effect below depends on nothing that changes while the
   * operator is flying. A cloud gaining a card resizes the canvas, and
   * re-registering the listeners on that would strand every held key with
   * no keyup listener left to release it.
   */
  const boundsRef = useRef({
    canvas: params.canvas,
    viewport: params.viewport,
  });
  const callbacksRef = useRef({
    onPaint: params.onPaint,
    onCommit: params.onCommit,
    onMoveStart: params.onMoveStart,
    onResetView: params.onResetView,
  });
  useEffect(() => {
    boundsRef.current = { canvas: params.canvas, viewport: params.viewport };
    callbacksRef.current = {
      onPaint: params.onPaint,
      onCommit: params.onCommit,
      onMoveStart: params.onMoveStart,
      onResetView: params.onResetView,
    };
  });

  const { layerRef, liveViewRef } = params;

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;

    let frame = 0;
    let last = 0;

    const setHeldKeys = (next: ReadonlySet<StarMapCameraKey>) => {
      heldRef.current = next;
      setHeld(next);
    };

    /** Hand the flown-to view back to React and stop integrating. */
    const land = () => {
      flyingRef.current = false;
      last = 0;
      callbacksRef.current.onCommit(liveViewRef.current);
    };

    const runFrame = (now: number) => {
      frame = 0;
      if (heldRef.current.size === 0) {
        land();
        return;
      }
      // The first frame of a flight has no previous timestamp to measure
      // against; assume one 60Hz frame rather than integrating zero, so a
      // tap released before the second frame still moves the map.
      const elapsed = last === 0 ? 1000 / 60 : now - last;
      last = now;
      // Reads the SHARED live view every frame, so a pinch or a reset that
      // landed since the last frame is the base this one builds on.
      const next = stepStarMapCamera({
        view: liveViewRef.current,
        held: heldRef.current,
        elapsedMs: elapsed,
        sprint: sprintRef.current,
        canvas: boundsRef.current.canvas,
        viewport: boundsRef.current.viewport,
      });
      callbacksRef.current.onPaint(next);
      frame = requestAnimationFrame(runFrame);
    };

    const fly = () => {
      if (frame) return;
      flyingRef.current = true;
      frame = requestAnimationFrame(runFrame);
    };

    /**
     * Whether the map should answer the keyboard at all right now.
     *
     * Bound on `window` rather than the layer, because the layer only sees
     * keys while focus is inside it — and focus escapes routinely (closing
     * the portaled intake dialog drops it on `document.body`), which left
     * the always-visible hint advertising keys that did nothing. Focus on
     * NOTHING means the map, since the map is the surface; focus on
     * something outside the layer belongs to that something.
     */
    const mapHasKeyboard = () => {
      const active = document.activeElement;
      if (!active || active === document.body) return true;
      return layer.contains(active);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl/Alt combinations belong to the app and the OS: Cmd-W is
      // "close window", not "fly up".
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!mapHasKeyboard()) return;
      if (isStarMapTypingTarget(event.target)) return;
      sprintRef.current = event.shiftKey;
      if (isStarMapResetViewKey(event)) {
        event.preventDefault();
        callbacksRef.current.onResetView();
        return;
      }
      const camera = resolveStarMapCameraKey(event);
      if (!camera) return;
      // Arrows would otherwise scroll whatever is under focus as well.
      event.preventDefault();
      // Auto-repeat re-fires keydown for a key that is already down; the
      // loop, not the repeat rate, is what moves the map.
      if (heldRef.current.has(camera)) return;
      setHeldKeys(new Set(heldRef.current).add(camera));
      callbacksRef.current.onMoveStart();
      fly();
    };

    /**
     * Keyup is on the window and ungated: a key pressed on the map and
     * released after focus moved elsewhere still has to come up, or the
     * camera flies on with nothing holding it.
     */
    const onKeyUp = (event: KeyboardEvent) => {
      sprintRef.current = event.shiftKey;
      const camera = resolveStarMapCameraKey(event);
      if (!camera || !heldRef.current.has(camera)) return;
      const next = new Set(heldRef.current);
      next.delete(camera);
      setHeldKeys(next);
    };

    /**
     * A window that loses focus never receives the keyup — Cmd-Tab away
     * mid-flight and the map would keep flying. Same for a hidden window,
     * whose animation frames stop arriving entirely.
     */
    const releaseAll = () => {
      if (heldRef.current.size === 0) return;
      setHeldKeys(NO_KEYS);
      // A scheduled frame will land on its own. Nothing is scheduled while
      // the window is hidden, so land here rather than waiting for a frame
      // that may never arrive.
      if (!frame) land();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", releaseAll);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", releaseAll);
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      // Teardown mid-flight (the map closing, or the thread floating over
      // it) still owes React the distance already flown, or the next render
      // snaps the canvas back to wherever the last commit left it.
      if (flyingRef.current) land();
      heldRef.current = NO_KEYS;
      setHeld(NO_KEYS);
    };
  }, [layerRef, liveViewRef]);

  return held;
}
