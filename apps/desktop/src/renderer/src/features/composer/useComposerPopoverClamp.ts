import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

/**
 * Keeps a composer popover inside the surface that actually clips it.
 *
 * The popovers opened from the composer's settings row (the branch picker,
 * the thread options menu, the Add reference picker) anchor to their
 * trigger's RIGHT edge and open leftward, because their triggers sit toward
 * the right of the row. The window is not what clips them: `main.app-main`,
 * `section.thread-view`, and `.thread-view__layout` are all
 * `overflow: hidden`, and the pane starts where the sidebar ends. A
 * window-only clamp therefore left the left edge of a 440px popover under
 * the sidebar whenever the chat column was narrower than the popover.
 *
 * The settings row (`.composer__setup`) lies inside that pane and left of a
 * pinned context rail, so clamping to it keeps the popover fully visible.
 * Outside a composer (the handoff dialog's branch field) the window gutters
 * are the only bound.
 */

/** Distance a popover keeps from the window edges. */
const WINDOW_GUTTER = 12;

export type ComposerPopoverClampInput = {
  /** The popover's measured right edge and width, with `shift` applied. */
  right: number;
  width: number;
  /** The `translateX` currently applied to the popover. */
  shift: number;
  /** The widest the popover has rendered since it opened (0 at first). */
  naturalWidth: number;
  /** Horizontal edges of the settings row, when there is one. */
  bounds?: { left: number; right: number };
  viewportWidth: number;
};

export type ComposerPopoverClamp = {
  naturalWidth: number;
  shift: number;
  /** A width cap, set only when the natural width does not fit. */
  widthLimit: number | undefined;
};

export function clampComposerPopover(
  input: ComposerPopoverClampInput,
): ComposerPopoverClamp {
  const leftBoundary = Math.max(
    WINDOW_GUTTER,
    input.bounds?.left ?? WINDOW_GUTTER,
  );
  const rightBoundary = Math.max(
    leftBoundary,
    Math.min(
      input.viewportWidth - WINDOW_GUTTER,
      input.bounds?.right ?? input.viewportWidth - WINDOW_GUTTER,
    ),
  );
  const availableWidth = Math.max(0, rightBoundary - leftBoundary);
  // A width cap applied on an earlier pass shrinks the measured width, so
  // remember the widest measurement; otherwise a window that grows again
  // could never give the popover its full width back.
  const naturalWidth = Math.max(input.naturalWidth, input.width);
  const targetWidth = Math.min(naturalWidth, availableWidth);
  // Right-anchored: a width cap moves the left edge and leaves the right
  // edge where the trigger put it.
  const unshiftedRight = input.right - input.shift;
  const unshiftedLeft = unshiftedRight - targetWidth;
  const targetLeft = Math.min(
    Math.max(unshiftedLeft, leftBoundary),
    rightBoundary - targetWidth,
  );
  return {
    naturalWidth,
    shift: targetLeft - unshiftedLeft,
    widthLimit: targetWidth < naturalWidth ? targetWidth : undefined,
  };
}

/**
 * Clamps the right-anchored popover in `menuRef` while `open`, and returns
 * the inline style that applies the clamp (undefined when none is needed).
 *
 * The clamp runs in a layout effect, before paint, so the popover never
 * shows at its unclamped position, and it re-clamps while open whenever the
 * window or the settings row resizes. A popover that focuses a search input
 * on open must do so after this effect (in a `requestAnimationFrame`, not
 * with `autoFocus`) and with `preventScroll`: focusing an input that is
 * still outside the pane scrolls the pane's `overflow: hidden` ancestors
 * sideways to reveal it.
 */
export function useComposerPopoverClamp(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [shift, setShift] = useState(0);
  const [widthLimit, setWidthLimit] = useState<number>();
  const shiftRef = useRef(0);
  const widthLimitRef = useRef<number | undefined>(undefined);
  const naturalWidthRef = useRef(0);

  useLayoutEffect(() => {
    if (!open) {
      shiftRef.current = 0;
      widthLimitRef.current = undefined;
      naturalWidthRef.current = 0;
      setShift(0);
      setWidthLimit(undefined);
      return;
    }
    const settingsRow =
      menuRef.current?.closest<HTMLElement>(".composer__setup") ?? null;
    const clamp = (): void => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }
      const rect = menu.getBoundingClientRect();
      const next = clampComposerPopover({
        bounds: settingsRow?.getBoundingClientRect(),
        naturalWidth: naturalWidthRef.current,
        right: rect.right,
        shift: shiftRef.current,
        viewportWidth: window.innerWidth,
        width: rect.width,
      });
      naturalWidthRef.current = next.naturalWidth;
      if (widthLimitRef.current !== next.widthLimit) {
        widthLimitRef.current = next.widthLimit;
        setWidthLimit(next.widthLimit);
      }
      if (shiftRef.current !== next.shift) {
        shiftRef.current = next.shift;
        setShift(next.shift);
      }
    };
    clamp();
    window.addEventListener("resize", clamp);
    // A window resize is not the last word on the row's width: a pinned
    // context rail's width depends on the viewport, and
    // `.thread-view__layout` animates the padding that reserves it, so the
    // row keeps resizing for 160ms after the last `resize` event. Watching
    // the row catches every frame of that, and a rail or sidebar change
    // while the popover is open. A move without a resize needs nothing: the
    // popover is positioned from its trigger, so it moves with the row.
    let observer: ResizeObserver | undefined;
    if (settingsRow && typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(clamp);
      observer.observe(settingsRow);
    }
    return () => {
      window.removeEventListener("resize", clamp);
      observer?.disconnect();
    };
  }, [menuRef, open]);

  if (!shift && widthLimit === undefined) {
    return undefined;
  }
  return {
    ...(shift ? { transform: `translateX(${shift}px)` } : {}),
    ...(widthLimit !== undefined
      ? {
          maxWidth: `${widthLimit}px`,
          minWidth: `${widthLimit}px`,
        }
      : {}),
  };
}
