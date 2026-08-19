import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  interpolateStarMapView,
  starMapFlightIsNoop,
  STAR_MAP_FLIGHT_DURATION_MS,
} from "./star-map-flight";
import type { StarMapView } from "./star-map-view-geometry";

/**
 * Whether the operator asked for less movement.
 *
 * Read per flight rather than cached: the setting can change while a
 * window is open, and a flight is cheap to decide about. Guarded because
 * jsdom (and any host without `matchMedia`) has no media queries at all.
 */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * Fly the map's camera to a view over time.
 *
 * The same shape as the keyboard camera and the pointer drag: frames are
 * painted straight onto the canvas transform through `onPaint`, and only
 * the landing is committed to React — a `setView` per frame re-renders
 * every card on the map to move one transform.
 *
 * The flight reads its base from the SHARED live view ref at the moment it
 * starts, and it is the only writer while it runs: anything the operator
 * does — a drag, a pinch, a camera key, "Reset view" — calls `cancel`
 * first, so the two never fight over the transform. Under
 * `prefers-reduced-motion` the flight lands immediately instead of
 * travelling; the operator still arrives, the sky just does not slide.
 */
export function useStarMapFlight(params: {
  /** Where the view is right now, shared with every other writer. */
  liveViewRef: RefObject<StarMapView>;
  /** Move the view for one frame, without telling React. */
  onPaint: (next: StarMapView) => void;
  /** Hand the flown-to view back to React on landing. */
  onCommit: (next: StarMapView) => void;
}): {
  flyTo: (target: StarMapView) => void;
  cancel: () => void;
} {
  const callbacksRef = useRef({
    onPaint: params.onPaint,
    onCommit: params.onCommit,
  });
  useEffect(() => {
    callbacksRef.current = {
      onPaint: params.onPaint,
      onCommit: params.onCommit,
    };
  });

  const frameRef = useRef(0);
  const { liveViewRef } = params;

  const cancel = useCallback(() => {
    if (!frameRef.current) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    // The distance already flown is real: commit it, or the next render
    // snaps the canvas back to wherever the last commit left it.
    callbacksRef.current.onCommit(liveViewRef.current);
  }, [liveViewRef]);

  const flyTo = useCallback(
    (target: StarMapView) => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      const from = liveViewRef.current;
      if (starMapFlightIsNoop(from, target) || prefersReducedMotion()) {
        callbacksRef.current.onCommit(target);
        return;
      }
      let start = 0;
      const step = (now: number) => {
        // The first frame has no previous timestamp to measure against, so
        // it is the flight's own zero rather than a guessed elapsed time.
        if (start === 0) start = now;
        const progress = Math.min(
          1,
          (now - start) / STAR_MAP_FLIGHT_DURATION_MS,
        );
        if (progress >= 1) {
          frameRef.current = 0;
          callbacksRef.current.onCommit(target);
          return;
        }
        callbacksRef.current.onPaint(
          interpolateStarMapView(from, target, progress),
        );
        frameRef.current = requestAnimationFrame(step);
      };
      frameRef.current = requestAnimationFrame(step);
    },
    [liveViewRef],
  );

  useEffect(() => {
    return () => {
      if (!frameRef.current) return;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
    };
  }, []);

  return { flyTo, cancel };
}
