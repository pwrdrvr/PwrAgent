import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A callback with a permanently stable identity that always runs the latest
 * implementation.
 *
 * Sidebar rows are the reason this exists. A row's handlers are rebuilt on
 * every render because they close over the row's own data, so a memoized row
 * or chip re-renders on every parent render no matter how stable its data is
 * — measured on the Directories lens as `PrChip` taking 256 renders and
 * `AddReactionChip` 330, every one of them blamed on a callback prop and
 * nothing else.
 *
 * `useCallback` cannot fix that case on its own: the dependency list would
 * have to name values that genuinely change (the thread, the parent's own
 * handlers), so the identity would change with them. Holding the
 * implementation in a ref decouples identity from dependencies entirely, and
 * removes the dependency list as a place to get it wrong — `exhaustive-deps`
 * is a warning in this repository, so a stale closure would not fail CI.
 *
 * **Only for handlers invoked after commit.** The ref is written in a layout
 * effect, so during a render it still holds the PREVIOUS render's closure.
 * Event handlers, timers, and effect bodies are safe; anything called during
 * render is not, and must use `useCallback` with a real dependency list.
 */
export function useEventCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
