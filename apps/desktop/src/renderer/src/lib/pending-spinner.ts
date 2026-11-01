import { observeElementVisibility } from "./observe-element-visibility";

/**
 * Keep the busy ring moving continuously while visible. Chromium requests a
 * BeginFrame every refresh even for an offscreen infinite transform, so pause
 * rings clipped by a scroller, hidden pane or background window. Reuse the PR
 * chips' shared observer; there is no per-ring observer, timer or React state.
 * React 19 runs the returned cleanup on unmount and Strict Mode ref replays.
 */
export function pendingSpinnerRef(element: HTMLSpanElement | null): (() => void) | undefined {
  if (!element) return;
  return observeElementVisibility(element, (visible) => {
    element.dataset.spinnerVisible = String(visible);
  });
}
