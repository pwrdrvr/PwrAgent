import type { PointerEvent as ReactPointerEvent } from "react";
import { beginNativeDragInteraction, endNativeDragInteraction } from "../../lib/native-drag-interaction";
import type { DropIndicatorController, DropIndicatorPosition } from "./drag-drop";
import { createThreadRowPointerDragPreview, type ThreadRowPointerDragPreview } from "./thread-row-drag-preview";

const POST_DRAG_CLICK_SUPPRESS_MS = 150;
const POINTER_DRAG_ACTIVATION_PX = 4;

export type Point = { x: number; y: number };

/**
 * Where a drop would land. A `position` draws the accent insertion line on
 * `element`; without one the element itself is the target and carries
 * `.is-drop-target` (the Directories divider, for an unpin).
 */
export type PointerReorderTarget<T> = {
  element: HTMLElement;
  key: string;
  position?: DropIndicatorPosition;
  /** What the drop does, printed on the held card. */
  label?: string;
  value: T;
};

export type PointerReorderDragOptions<T> = {
  event: ReactPointerEvent<HTMLElement>;
  /** Dimmed in place while the card is held. */
  sourceElement: HTMLElement;
  /** Holds the `.thread-row` the held card clones. */
  previewSource: HTMLElement;
  /** Keeps the clone's compact geometry (a project header). */
  compactPreview?: boolean;
  /** Swallows the click a browser synthesizes on release. */
  clickSuppressionRoot: HTMLElement;
  scrollElement?: HTMLElement;
  dropIndicator: DropIndicatorController;
  resolveTarget: (point: Point) => PointerReorderTarget<T> | undefined;
  /** Runs once the pointer passes the lift threshold, before the first hit test. */
  onLift?: () => void;
  /** Runs once the card is released or the drag is canceled, before `onDrop`. */
  onSettle?: (dropped: PointerReorderTarget<T> | undefined) => void;
  onDrop: (target: PointerReorderTarget<T>) => void;
};

/**
 * One pointer-driven sidebar reorder: a 4px lift, the tilted held card, a
 * dimmed source, an insertion line or target highlight, Escape and blur to
 * cancel. Native HTML drag is avoided for the reason `useThreadPinOrdering`
 * gives: Chromium suppresses ordinary input during it, and its macOS trackpad
 * path can queue scroll momentum for seconds at a scroll boundary. Hit tests
 * batch to one per animation frame and scrolling stays browser-controlled.
 *
 * Returns a function that ends the session: it cancels a drag still in
 * progress and drops the release-click suppression a finished one keeps
 * for a moment. Owners hold it until unmount, past the drag's own end.
 */
export function beginPointerReorderDrag<T>(options: PointerReorderDragOptions<T>): () => void {
  const { event, sourceElement, dropIndicator } = options;
  const startPoint = { x: event.clientX, y: event.clientY };
  const pointerId = event.pointerId;
  let lastPoint = startPoint;
  let activated = false;
  let canceled = false;
  let settled = false;
  let finished = false;
  let frame = 0;
  let preview: ThreadRowPointerDragPreview | undefined;
  let target: PointerReorderTarget<T> | undefined;
  let highlighted: HTMLElement | undefined;
  let suppressClickTimer: number | undefined;

  const clearTarget = (): void => {
    dropIndicator.clear();
    highlighted?.classList.remove("is-drop-target");
    highlighted = undefined;
  };
  const showTarget = (next: PointerReorderTarget<T> | undefined): void => {
    target = next;
    preview?.setDropLabel(next?.label);
    if (!next) {
      clearTarget();
      return;
    }
    if (next.position) {
      highlighted?.classList.remove("is-drop-target");
      highlighted = undefined;
      dropIndicator.show(next.element, { targetKey: next.key, position: next.position });
      return;
    }
    dropIndicator.clear();
    if (highlighted !== next.element) {
      highlighted?.classList.remove("is-drop-target");
      highlighted = next.element;
      highlighted.classList.add("is-drop-target");
    }
  };
  const isOverSource = (point: Point): boolean => {
    const bounds = sourceElement.getBoundingClientRect();
    return bounds.right > bounds.left && bounds.bottom > bounds.top
      && point.x >= bounds.left && point.x <= bounds.right
      && point.y >= bounds.top && point.y <= bounds.bottom;
  };
  const update = (): void => {
    preview?.move(lastPoint);
    showTarget(canceled || isOverSource(lastPoint) ? undefined : options.resolveTarget(lastPoint));
  };
  const schedule = (): void => {
    if (frame || !activated || canceled) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      update();
    });
  };

  const removeClickSuppression = (): void => {
    options.clickSuppressionRoot.removeEventListener("click", suppressReleaseClick, true);
    if (suppressClickTimer !== undefined) {
      window.clearTimeout(suppressClickTimer);
      suppressClickTimer = undefined;
    }
  };
  function suppressReleaseClick(clickEvent: globalThis.MouseEvent): void {
    clickEvent.preventDefault();
    clickEvent.stopImmediatePropagation();
    removeClickSuppression();
  }

  const activate = (): void => {
    if (activated || canceled) return;
    activated = true;
    beginNativeDragInteraction();
    // Measure the held card before `onLift` changes the layout under it.
    preview = createThreadRowPointerDragPreview(options.previewSource, startPoint, {
      compact: options.compactPreview,
    });
    sourceElement.classList.add("is-pointer-dragging");
    options.clickSuppressionRoot.addEventListener("click", suppressReleaseClick, true);
    options.scrollElement?.addEventListener("scroll", schedule, { passive: true });
    options.onLift?.();
    schedule();
  };
  const deactivate = (): void => {
    if (frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
    preview?.remove();
    preview = undefined;
    sourceElement.classList.remove("is-pointer-dragging");
    clearTarget();
    options.scrollElement?.removeEventListener("scroll", schedule);
    if (activated) endNativeDragInteraction();
  };
  // Put the list back. Escape does this at once; the release still arrives
  // later, and its click must still be swallowed.
  const settle = (dropped: PointerReorderTarget<T> | undefined): void => {
    if (settled) return;
    settled = true;
    const wasActivated = activated;
    deactivate();
    if (wasActivated) options.onSettle?.(dropped);
  };
  const finish = (dropped: PointerReorderTarget<T> | undefined): void => {
    if (finished) return;
    finished = true;
    const wasActivated = activated;
    const alreadySettled = settled;
    settle(dropped);
    removeListeners();
    if (!wasActivated) return;
    suppressClickTimer = window.setTimeout(removeClickSuppression, POST_DRAG_CLICK_SUPPRESS_MS);
    if (dropped && !alreadySettled) options.onDrop(dropped);
  };

  const move = (pointerEvent: globalThis.PointerEvent): void => {
    if (pointerEvent.pointerId !== pointerId || canceled) return;
    lastPoint = { x: pointerEvent.clientX, y: pointerEvent.clientY };
    if (!activated && Math.hypot(lastPoint.x - startPoint.x, lastPoint.y - startPoint.y) < POINTER_DRAG_ACTIVATION_PX) {
      return;
    }
    activate();
    pointerEvent.preventDefault();
    schedule();
  };
  const stop = (pointerEvent: globalThis.PointerEvent): void => {
    if (pointerEvent.pointerId !== pointerId) return;
    lastPoint = { x: pointerEvent.clientX, y: pointerEvent.clientY };
    if (activated && !canceled) {
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      update();
    }
    finish(canceled ? undefined : target);
  };
  const cancel = (): void => {
    canceled = true;
    finish(undefined);
  };
  const cancelOnPointer = (pointerEvent: globalThis.PointerEvent): void => {
    if (pointerEvent.pointerId === pointerId) cancel();
  };
  const cancelOnEscape = (keyboardEvent: globalThis.KeyboardEvent): void => {
    if (keyboardEvent.key !== "Escape" || !activated || canceled) return;
    keyboardEvent.preventDefault();
    canceled = true;
    settle(undefined);
  };
  function removeListeners(): void {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", cancelOnPointer);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", cancelOnEscape, true);
  }
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop);
  window.addEventListener("pointercancel", cancelOnPointer);
  window.addEventListener("blur", cancel);
  window.addEventListener("keydown", cancelOnEscape, true);
  return () => {
    // Cancelling a live drag arms the suppression, so drop it after.
    cancel();
    removeClickSuppression();
  };
}
