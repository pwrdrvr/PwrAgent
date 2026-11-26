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

function collectRowSiblings(settingsRow: HTMLElement, menu: HTMLElement): Element[] {
  const siblings: Element[] = [];
  const visit = (parent: Element): void => {
    for (const child of Array.from(parent.children)) {
      const transparentFieldset =
        child.tagName === "FIELDSET"
        && child.classList.contains("composer__pending-controls");
      if (transparentFieldset) {
        visit(child);
        continue;
      }
      if (child === menu || child.contains(menu)) {
        continue;
      }
      siblings.push(child);
    }
  };
  visit(settingsRow);
  return siblings;
}

/**
 * Clamps the right-anchored popover in `menuRef` while `open`, and returns
 * the inline style that applies the clamp (undefined when none is needed).
 *
 * The clamp runs in a layout effect, before paint, so the popover never
 * shows at its unclamped position, and it re-clamps while open whenever the
 * window, the settings row, or any sibling chip inside the row resizes or
 * mounts/unmounts. Watching sibling items is necessary because `.composer__setup`
 * can already hold multiple wrapped rows (for example, workspace tools and
 * send actions on row 2), so a trigger wrapping from row 1 to row 2 changes
 * its horizontal position without changing `.composer__setup`'s outer width
 * or height. A popover that focuses a search input on open must do so after
 * this effect (in a `requestAnimationFrame`, not with `autoFocus`) and with
 * `preventScroll`: focusing an input that is still outside the pane scrolls
 * the pane's `overflow: hidden` ancestors sideways to reveal it.
 */
export function useComposerPopoverClamp(
  open: boolean,
  menuRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [shift, setShift] = useState(0);
  const [widthLimit, setWidthLimit] = useState<number>();
  // `appliedShiftRef` tracks only the transform already committed to the DOM,
  // while `requestedShiftRef` deduplicates pending state updates before commit.
  const appliedShiftRef = useRef(0);
  const requestedShiftRef = useRef(0);
  const widthLimitRef = useRef<number | undefined>(undefined);
  const naturalWidthRef = useRef(0);

  useLayoutEffect(() => {
    appliedShiftRef.current = open ? shift : 0;
  }, [open, shift]);

  useLayoutEffect(() => {
    if (!open) {
      appliedShiftRef.current = 0;
      requestedShiftRef.current = 0;
      widthLimitRef.current = undefined;
      naturalWidthRef.current = 0;
      setShift(0);
      setWidthLimit(undefined);
      return;
    }
    let disposed = false;
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
        shift: appliedShiftRef.current,
        viewportWidth: window.innerWidth,
        width: rect.width,
      });
      naturalWidthRef.current = next.naturalWidth;
      if (widthLimitRef.current !== next.widthLimit) {
        widthLimitRef.current = next.widthLimit;
        setWidthLimit(next.widthLimit);
      }
      if (requestedShiftRef.current !== next.shift) {
        requestedShiftRef.current = next.shift;
        setShift(next.shift);
      }
    };
    clamp();
    window.addEventListener("resize", clamp);
    // A window resize is not the last word on the row's width or on a
    // trigger's wrapped line: a pinned context rail animates its width, and
    // sibling chips can hydrate or widen and wrap the trigger onto an existing
    // second row without changing `.composer__setup`'s outer box.
    let resizeObserver: ResizeObserver | undefined;
    const observedSiblings = new Set<Element>();
    const syncSiblingObservers = (): void => {
      if (!resizeObserver || !settingsRow || !menuRef.current) {
        return;
      }
      const nextSiblings = new Set(collectRowSiblings(settingsRow, menuRef.current));
      for (const existing of Array.from(observedSiblings)) {
        if (!nextSiblings.has(existing)) {
          resizeObserver.unobserve?.(existing);
          observedSiblings.delete(existing);
        }
      }
      for (const sibling of nextSiblings) {
        if (!observedSiblings.has(sibling)) {
          resizeObserver.observe(sibling);
          observedSiblings.add(sibling);
        }
      }
    };
    if (settingsRow && typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(clamp);
      resizeObserver.observe(settingsRow);
      syncSiblingObservers();
    }
    let mutationObserver: MutationObserver | undefined;
    if (settingsRow && typeof MutationObserver !== "undefined") {
      mutationObserver = new MutationObserver((records) => {
        const menu = menuRef.current;
        const externalMutation = records.some(
          (record) => !menu || !menu.contains(record.target),
        );
        if (!externalMutation) {
          return;
        }
        syncSiblingObservers();
        clamp();
      });
      mutationObserver.observe(settingsRow, { childList: true, subtree: true });
    }
    if (typeof document !== "undefined" && document.fonts?.status === "loading") {
      void document.fonts.ready.then(() => {
        if (!disposed) {
          clamp();
        }
      });
    }
    return () => {
      disposed = true;
      window.removeEventListener("resize", clamp);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
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
