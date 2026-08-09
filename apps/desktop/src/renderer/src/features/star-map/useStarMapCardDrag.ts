import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { pointerDeltaToCanvas, resolveCardDragOffset } from "./star-map-layout";
import type { AlignmentGuide } from "./star-map-snapping";

const DRAG_THRESHOLD_PX = 4;

export type StarMapCardDrag = {
  /**
   * Where drag resistance begins, measured from the INSTANCE BODY — one
   * region shared by the whole cloud (`cloudDetentRadius`), not a per-card
   * allowance, so any card can be placed where any other card sits. Past it
   * the drag is resisted, not stopped.
   */
  detentRadius: number;
  /**
   * Current canvas scale. Pointer deltas arrive in screen pixels but the card
   * is positioned in canvas pixels, so without this the card moves `scale`
   * times too far and slides out from under the cursor.
   */
  scale: number;
  /**
   * Snap a proposed offset against the rest of the arrangement. The screen
   * owns this because it is the only thing that knows where every other card
   * sits; a card would otherwise have to reconstruct the whole map to align
   * with one neighbour. Optional: cards that are not part of the arrangement
   * grid (the load card) drag without snapping.
   */
  snap?: (offset: { dx: number; dy: number }) => {
    dx: number;
    dy: number;
    guides: AlignmentGuide[];
  };
  /** Guides to draw while this drag is live; empty clears them. */
  onGuidesChange?: (guides: AlignmentGuide[]) => void;
  /**
   * How far this drag has travelled, so the screen can carry the rest of a
   * multi-card selection along. Fired per frame during the drag and once
   * more on release, when the movement becomes durable.
   */
  onGroupDelta?: (delta: { dx: number; dy: number }) => void;
  onGroupCommit?: (delta: { dx: number; dy: number }) => void;
  onCommitOffset: (offset: { dx: number; dy: number }) => void;
};

/**
 * Pointer-drag for a positioned star-map card. Shared by every card type on
 * the map so the feel — 4px threshold, screen-to-canvas delta conversion,
 * detent resistance past the cloud radius, snapping and alignment guides,
 * group movement for a multi-card selection, rAF-batched writes straight to
 * `style.left/top`, and click suppression on release — cannot drift between
 * them.
 *
 * The hook writes the element's inline position during the gesture and
 * commits the resolved offset once, on release; React re-renders from the
 * synced arrangement afterwards.
 */
export function useStarMapCardDrag(params: {
  baseSlot: { dx: number; dy: number };
  offset?: { dx: number; dy: number };
  drag?: StarMapCardDrag;
}): {
  startDrag: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /**
   * Mark the release click as consumed without starting a drag — for a
   * gesture the card handles itself, such as modifier-click selection.
   */
  suppressClick: () => void;
  /**
   * True when the gesture that just ended was a drag, so the click the
   * browser fires on release must not also activate the card. Reading it
   * clears it.
   */
  consumeSuppressedClick: () => boolean;
} {
  const suppressClickRef = useRef(false);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = params.drag;
    if (!drag || event.button !== 0) return;
    const element = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = params.offset ?? { dx: 0, dy: 0 };
    const baseSlot = params.baseSlot;
    let dragging = false;
    let lastDx = startOffset.dx;
    let lastDy = startOffset.dy;
    let frame = 0;
    const move = (pointerEvent: globalThis.PointerEvent) => {
      const screenX = pointerEvent.clientX - startX;
      const screenY = pointerEvent.clientY - startY;
      // The threshold is about human intent, so it stays in screen pixels;
      // only the movement itself converts into canvas space.
      if (
        !dragging
        && Math.hypot(screenX, screenY) < DRAG_THRESHOLD_PX
      ) {
        return;
      }
      dragging = true;
      suppressClickRef.current = true;
      const delta = pointerDeltaToCanvas({
        dx: screenX,
        dy: screenY,
        scale: drag.scale,
      });
      const resolved = resolveCardDragOffset({
        baseSlot,
        offset: {
          dx: startOffset.dx + delta.dx,
          dy: startOffset.dy + delta.dy,
        },
        detentRadius: drag.detentRadius,
      });
      const snapped = drag.snap ? drag.snap(resolved) : undefined;
      lastDx = snapped ? snapped.dx : resolved.dx;
      lastDy = snapped ? snapped.dy : resolved.dy;
      drag.onGuidesChange?.(snapped?.guides ?? []);
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          element.style.left = `${baseSlot.dx + lastDx}px`;
          element.style.top = `${baseSlot.dy + lastDy}px`;
          drag.onGroupDelta?.({
            dx: lastDx - startOffset.dx,
            dy: lastDy - startOffset.dy,
          });
        });
      }
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      drag.onGuidesChange?.([]);
      if (dragging) {
        drag.onCommitOffset({ dx: lastDx, dy: lastDy });
        drag.onGroupCommit?.({
          dx: lastDx - startOffset.dx,
          dy: lastDy - startOffset.dy,
        });
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  return {
    startDrag,
    suppressClick: () => {
      suppressClickRef.current = true;
    },
    consumeSuppressedClick: () => {
      if (!suppressClickRef.current) return false;
      suppressClickRef.current = false;
      return true;
    },
  };
}
