import { memo, useMemo, useSyncExternalStore, type CSSProperties } from "react";
import type { CelestialIconId } from "@pwragent/shared";
import { CelestialIcon } from "../../icons";
import {
  computeStarMapEdgeArrows,
  type StarMapEdgeTarget,
} from "./star-map-edge-arrows";
import type { StarMapView, StarMapViewBox } from "./star-map-view-geometry";

/** A body the arrows can point at: an instance or a project sun. */
export type StarMapEdgeArrowTarget = StarMapEdgeTarget & {
  label: string;
  kind: "instance" | "project";
  /** The instance's celestial icon; projects carry a core dot instead. */
  icon?: CelestialIconId;
};

/**
 * Pointers on the edge of the window to every body the window is not
 * showing, each turned to the bearing of its body and clickable to fly
 * there. The geometry is `computeStarMapEdgeArrows`; this is the DOM.
 *
 * Reads the LIVE view, not React's. A drag, a keyboard flight and a ⌘K
 * flight all paint the canvas transform by hand for their whole duration
 * and commit to state only on landing, so an overlay fed from state would
 * sit still through every gesture and jump at the end — the opposite of
 * "the arrows move as you pan". `subscribe` is pinged on every paint, and
 * `useSyncExternalStore` re-renders just this component, synchronously,
 * so the arrows and the canvas land in the same frame. That is cheap
 * because the component is a dozen nodes; the screen as a whole is not,
 * which is why `paintView` exists in the first place.
 *
 * Memoised against its props for the same reason: a commit re-renders the
 * screen, and this must not pay for that twice (once by the store, once
 * by the parent) unless a target or the window actually changed.
 */
export const StarMapEdgeArrows = memo(function StarMapEdgeArrows(props: {
  targets: readonly StarMapEdgeArrowTarget[];
  viewport: StarMapViewBox;
  /** Called on every write of the live view, committed or painted. */
  subscribe: (listener: () => void) => () => void;
  /** The view as the canvas transform shows it right now. */
  getView: () => StarMapView;
  onFlyTo: (target: StarMapEdgeArrowTarget) => void;
}) {
  const view = useSyncExternalStore(props.subscribe, props.getView);
  const arrows = useMemo(
    () =>
      computeStarMapEdgeArrows({
        targets: props.targets,
        view,
        viewport: props.viewport,
      }),
    [props.targets, props.viewport, view],
  );
  // Nothing off-screen, nothing in the tree: an empty group has nothing to
  // announce and would only be a landmark for a screen reader to visit.
  if (arrows.length === 0) return null;
  return (
    <div
      className="star-map__edge-arrows"
      role="group"
      aria-label="Off-screen bodies"
    >
      {arrows.map((arrow) => (
        <button
          key={arrow.target.key}
          type="button"
          className={`star-map__edge-arrow star-map__edge-arrow--${arrow.edge}`}
          // The button is the pill; the head hangs off it back at the
          // rail point. Position is the tip of the head, and the per-edge
          // CSS translates the pill inward from there and slides it along
          // the edge by `--star-map-edge-shift` (see the geometry), while
          // the head undoes that slide so it stays on the ray.
          style={
            {
              left: arrow.x,
              top: arrow.y,
              "--star-map-edge-angle": `${arrow.angle}deg`,
              "--star-map-edge-shift": `${arrow.labelShift}px`,
            } as CSSProperties
          }
          aria-label={`Fly to ${arrow.target.label}`}
          onClick={() => props.onFlyTo(arrow.target)}
        >
          <span className="star-map__edge-arrow-head" aria-hidden="true">
            {/* A dart pointing +x; `rotate(var(--star-map-edge-angle))`
                turns it along the ray. */}
            <svg viewBox="0 0 18 18" width="18" height="18">
              <path d="M2.5 2.5 L16 9 L2.5 15.5 L6.2 9 Z" />
            </svg>
          </span>
          {arrow.target.icon ? (
            <CelestialIcon
              icon={arrow.target.icon}
              size={14}
              className="star-map__edge-arrow-icon"
            />
          ) : arrow.target.kind === "project" ? (
            <span className="star-map__edge-arrow-core" aria-hidden="true" />
          ) : null}
          <span className="star-map__edge-arrow-name">{arrow.target.label}</span>
        </button>
      ))}
    </div>
  );
});
