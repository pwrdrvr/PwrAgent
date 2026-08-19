import { useEffect, useRef } from "react";
import type { DesktopApi } from "../../lib/desktop-api";
import {
  buildStarMapViewSnapshot,
  type StarMapViewSnapshotInput,
} from "./star-map-view-snapshot";

/**
 * Slowest the map republishes while the operator is moving it. A drag
 * changes the input on every frame; an Agent reading the view a moment
 * later does not care which of those frames it gets, and the `ageMs` the
 * tool reports keeps the staleness visible either way.
 */
export const STAR_MAP_VIEW_PUBLISH_INTERVAL_MS = 750;

/**
 * Publish the map's on-screen state to the main process for the
 * `read_star_map_view` Agent tool.
 *
 * The snapshot is built inside the throttle, not on every render: building
 * walks every cloud and thread, and this hook sits on the drag path. The
 * caller therefore passes a memoized input rather than a finished snapshot.
 */
export function useStarMapViewPublisher(params: {
  desktopApi?: DesktopApi;
  input: StarMapViewSnapshotInput;
  intervalMs?: number;
}): void {
  const inputRef = useRef(params.input);
  inputRef.current = params.input;
  const publishRef = useRef<{ lastAt: number; timer?: number }>({ lastAt: 0 });
  const publish = params.desktopApi?.publishStarMapView;
  const intervalMs = params.intervalMs ?? STAR_MAP_VIEW_PUBLISH_INTERVAL_MS;

  useEffect(() => {
    if (!publish) return;
    const state = publishRef.current;
    const send = () => {
      state.lastAt = Date.now();
      state.timer = undefined;
      void publish(buildStarMapViewSnapshot(inputRef.current)).catch(() => {
        // Best effort: the map stays usable whether or not any Agent is
        // asking about it, so a failed publish must not surface as an error.
      });
    };
    const sinceLast = Date.now() - state.lastAt;
    if (sinceLast >= intervalMs) {
      send();
      return;
    }
    if (state.timer !== undefined) return;
    // Trailing edge: whatever the input settles on inside the window is what
    // gets published, so a drag reports where the card landed rather than
    // where it was picked up. Deliberately not cleared per render — the
    // pending publish is the one carrying the newest input, and cancelling it
    // on every re-render would mean a moving map never publishes at all.
    state.timer = window.setTimeout(send, intervalMs - sinceLast);
  }, [intervalMs, params.input, publish]);

  useEffect(() => {
    const state = publishRef.current;
    return () => {
      if (state.timer !== undefined) {
        window.clearTimeout(state.timer);
        state.timer = undefined;
      }
    };
  }, []);
}
