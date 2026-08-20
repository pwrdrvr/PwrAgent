import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type RefObject,
} from "react";
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
 *
 * Being the only writer is what makes `stepBy` necessary. A running leg is
 * two views captured at launch, so it is the one writer that does NOT read
 * the live ref per frame — which is right for the operator (nothing may
 * deflect a flight) and wrong for the map's own contents, which can move
 * the destination out from under a leg that is still travelling to it.
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
  stepBy: (step: { x: number; y: number }) => void;
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
  /**
   * The leg currently being flown: where it left from and where it lands,
   * both in viewport pixels, or undefined when nothing is flying.
   *
   * Held in a ref and mutated in place rather than captured in `flyTo`'s
   * closure, because `stepBy` has to reach the same two views the next
   * frame will interpolate between.
   */
  const legRef = useRef<{ from: StarMapView; to: StarMapView } | undefined>(
    undefined,
  );
  const { liveViewRef } = params;

  const cancel = useCallback(() => {
    if (!frameRef.current) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = 0;
    legRef.current = undefined;
    // The distance already flown is real: commit it, or the next render
    // snaps the canvas back to wherever the last commit left it.
    callbacksRef.current.onCommit(liveViewRef.current);
  }, [liveViewRef]);

  /**
   * Move a running leg with the map underneath it.
   *
   * The map's contents can re-base while a flight is in the air: the
   * radial lenses normalise their canvas around what they laid out, so a
   * peer snapshot or an unfolded cloud moves every body — the card being
   * flown to included — by the same amount, and the screen answers that by
   * stepping the view back. A leg captured before the re-base knows
   * nothing about it, and paints straight over that step on its next
   * frame: the map jumps back to the shift the screen just cancelled, once
   * per snapshot for the whole flight.
   *
   * Both ends move, and by the same `step` the view took. `from` because
   * the flight has to stay continuous with the frame already on screen;
   * `to` because a destination expressed as "centre this card" has moved
   * exactly as far as the card did, so a leg that kept its original target
   * would land next to the card it was asked to find.
   *
   * A no-op when nothing is flying, so callers need not ask first.
   */
  const stepBy = useCallback((step: { x: number; y: number }) => {
    const leg = legRef.current;
    if (!leg) return;
    leg.from.x -= step.x;
    leg.from.y -= step.y;
    leg.to.x -= step.x;
    leg.to.y -= step.y;
  }, []);

  const flyTo = useCallback(
    (target: StarMapView) => {
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = 0;
      }
      const from = liveViewRef.current;
      if (starMapFlightIsNoop(from, target) || prefersReducedMotion()) {
        legRef.current = undefined;
        callbacksRef.current.onCommit(target);
        return;
      }
      // Copies, because `stepBy` moves both ends in place and neither the
      // live view ref nor the caller's target is ours to write.
      const leg = { from: { ...from }, to: { ...target } };
      legRef.current = leg;
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
          legRef.current = undefined;
          // The leg's own target, not the caller's: a re-base mid-flight
          // moved the card, and this is where the card ended up.
          callbacksRef.current.onCommit(leg.to);
          return;
        }
        callbacksRef.current.onPaint(
          interpolateStarMapView(leg.from, leg.to, progress),
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
      legRef.current = undefined;
    };
  }, []);

  // Memoised as one object: consumers put `cancel` in the dependency list
  // of a `useEffect` that registers a non-passive wheel listener, and a
  // fresh literal every render would tear that listener down and re-add it
  // on every streamed update. Same rule as `useStarMapArrangement`.
  return useMemo(
    () => ({ flyTo, cancel, stepBy }),
    [cancel, flyTo, stepBy],
  );
}
