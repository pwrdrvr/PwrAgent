/** One unit of work folded onto the next animation frame. */
export interface FrameCoalescer {
  /**
   * Ask for the work to run on the next animation frame.
   *
   * A request that arrives while a frame is already queued is **dropped**,
   * not queued behind it and not replacing it: the frame that is already
   * queued runs, once. Every coalescer in this renderer schedules a closure
   * that reads its inputs at frame time — the drag's latest pointer travel,
   * the terminal's current size — rather than capturing them at schedule
   * time, so dropping and replacing produce the same frame, and dropping is
   * the one that does no work to get there.
   */
  schedule: () => void;
  /**
   * Drop a queued frame.
   *
   * A no-op when nothing is queued, and the coalescer stays usable
   * afterwards, so a gesture that stops and starts again can keep the same
   * one. Owners call this from whatever tears the work's subject down — an
   * effect cleanup, a `pointerup` handler — because the queued callback
   * outlives the thing it was going to touch otherwise.
   */
  cancel: () => void;
}

/**
 * Coalesce repeated requests to do the same work onto one animation frame.
 *
 * The renderer grew several hand-written copies of this — a pan drag, a card
 * drag, the sidebar resize, the terminal's fit-and-resize, the Settings
 * scroll clamp, the thread-pin drop target — and each copy re-answered the
 * same three questions from scratch. They happened to agree, but nothing
 * made them agree.
 *
 * Two of those answers live here: a request during a queued frame is
 * dropped, and `cancel` is available for the owner to call on teardown.
 *
 * The third stays at the call site on purpose. **Whether the work should run
 * at all is not this primitive's question**, because scheduling-time and
 * frame-time guards are different behaviors and the difference has to stay
 * visible where it is decided. A caller that must not even queue a frame
 * writes the test before `schedule()`; a caller whose answer can change
 * while a frame is in flight writes it at the top of `run`, and then a frame
 * that spans the flip settles against the state at frame time.
 * `IntegratedTerminal` does both, and means both: it refuses to schedule
 * once the terminal is disposed, and re-checks visibility inside the frame
 * so a queued fit lands against the size the terminal actually has.
 */
export function createFrameCoalescer(run: () => void): FrameCoalescer {
  let frame: number | undefined;
  return {
    schedule: () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        // Cleared before the work runs, so work that schedules itself again
        // gets the next frame instead of being swallowed as a duplicate.
        frame = undefined;
        run();
      });
    },
    cancel: () => {
      if (frame === undefined) return;
      window.cancelAnimationFrame(frame);
      frame = undefined;
    },
  };
}
