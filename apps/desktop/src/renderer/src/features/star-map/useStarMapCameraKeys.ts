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
  /**
   * Off while a thread floats over the map: the map has shoved aside and
   * the operator is working in the thread, where `w` means `w`.
   */
  enabled: boolean;
  /** Keydown is scoped here, so the map only flies while it has focus. */
  layerRef: RefObject<HTMLElement | null>;
  /** The transformed canvas, written directly during flight. */
  canvasRef: RefObject<HTMLElement | null>;
  view: StarMapView;
  /** Untransformed canvas size for the current lens. */
  canvas: StarMapViewBox;
  viewport: StarMapViewBox;
  /** Commit the flown-to view once the keys are released. */
  onChange: (next: StarMapView) => void;
  /** First press claims the view for the operator, as a drag does. */
  onMoveStart: () => void;
  /** `0`: back to where the map opens. */
  onResetView: () => void;
}): ReadonlySet<StarMapCameraKey> {
  const [held, setHeld] = useState<ReadonlySet<StarMapCameraKey>>(NO_KEYS);
  const heldRef = useRef<ReadonlySet<StarMapCameraKey>>(NO_KEYS);
  const sprintRef = useRef(false);
  /** Live view during flight; the loop owns it, React state follows. */
  const viewRef = useRef(params.view);
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
    onChange: params.onChange,
    onMoveStart: params.onMoveStart,
    onResetView: params.onResetView,
  });
  useEffect(() => {
    boundsRef.current = { canvas: params.canvas, viewport: params.viewport };
    callbacksRef.current = {
      onChange: params.onChange,
      onMoveStart: params.onMoveStart,
      onResetView: params.onResetView,
    };
  });

  // Adopt outside writes to the view (wheel, reset, lens switch) only when
  // the keyboard is not flying; mid-flight the loop holds the newer value.
  useEffect(() => {
    if (flyingRef.current) return;
    viewRef.current = params.view;
  }, [params.view]);

  const { enabled, layerRef, canvasRef } = params;

  useEffect(() => {
    const layer = layerRef.current;
    if (!enabled || !layer) return;

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
      callbacksRef.current.onChange(viewRef.current);
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
      const next = stepStarMapCamera({
        view: viewRef.current,
        held: heldRef.current,
        elapsedMs: elapsed,
        sprint: sprintRef.current,
        canvas: boundsRef.current.canvas,
        viewport: boundsRef.current.viewport,
      });
      viewRef.current = next;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.style.transform =
          `translate(${next.x}px, ${next.y}px) scale(${next.scale})`;
      }
      frame = requestAnimationFrame(runFrame);
    };

    const fly = () => {
      if (frame) return;
      flyingRef.current = true;
      frame = requestAnimationFrame(runFrame);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      // Cmd/Ctrl/Alt combinations belong to the app and the OS: Cmd-W is
      // "close window", not "fly up".
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isStarMapTypingTarget(event.target)) return;
      sprintRef.current = event.shiftKey;
      if (isStarMapResetViewKey(event.key)) {
        event.preventDefault();
        callbacksRef.current.onResetView();
        return;
      }
      const camera = resolveStarMapCameraKey(event.key);
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
      const camera = resolveStarMapCameraKey(event.key);
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

    layer.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", releaseAll);
    return () => {
      layer.removeEventListener("keydown", onKeyDown);
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
  }, [enabled, layerRef, canvasRef]);

  return held;
}
