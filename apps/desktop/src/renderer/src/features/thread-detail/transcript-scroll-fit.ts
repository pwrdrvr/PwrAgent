import { useLayoutEffect, type RefObject } from "react";

/** The transcript's scroll container, as `TranscriptList` renders it. */
export const TRANSCRIPT_SCROLLER_SELECTOR = ".transcript-list__items";

/** The custom property a fitted body reads its height limit from. */
export const TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY = "--transcript-scrollport-height";

/**
 * Publishes the transcript scrollport's height on one expanded body, so its
 * stylesheet rule can keep the whole body inside the viewport.
 *
 * A body taller than the scrollport that also scrolls inside itself needs two
 * scrolls to read: the transcript's to reach its lower half, its own to move
 * the text. Capped to the scrollport it needs one. The value is written on the
 * body, not the scroller, so a resize restyles the open bodies and not every
 * element of a long transcript. Outside a transcript nothing is written and
 * the rule's viewport-unit fallback applies.
 */
export function useTranscriptScrollportHeight(
  ref: RefObject<HTMLElement | null>,
  /** Changes when the element `ref` names mounts later than its component. */
  mounted: boolean = true,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    const scroller = element?.closest<HTMLElement>(TRANSCRIPT_SCROLLER_SELECTOR);
    if (!element || !scroller) {
      return undefined;
    }

    const publish = () => {
      const height = scroller.clientHeight;
      if (height > 0) {
        element.style.setProperty(
          TRANSCRIPT_SCROLLPORT_HEIGHT_PROPERTY,
          `${height}px`,
        );
      }
    };
    publish();
    if (typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(publish);
    observer.observe(scroller);
    return () => {
      observer.disconnect();
    };
  }, [mounted, ref]);
}

/**
 * How far the scroller must move so a disclosure control sits where it was
 * clicked. `before` and `after` are the control's viewport tops around the
 * toggle; the result is added to `scrollTop`. Sub-pixel drift is left alone.
 */
export function disclosureScrollCorrection(before: number, after: number): number {
  const delta = after - before;
  return Math.abs(delta) < 1 ? 0 : delta;
}

/**
 * Keeps a clicked disclosure control under the pointer.
 *
 * Collapsing from a pinned header removes the body above the scroll position,
 * so without a correction the header's own row lands far above the viewport.
 * Expanding the last row of a transcript that follows its bottom did the
 * reverse: the growth was read as new output and the row was scrolled away.
 * `onLayoutChange` lets the list drop bottom-follow for a toggle that changed
 * the content's height; a control that opens a menu changes nothing and is
 * ignored.
 *
 * The listener is native and on the scroller, below React's root listener, so
 * it reads the control's position before React commits the toggle. React
 * flushes a click's updates before the task ends, so the frame callback sees
 * the committed layout and corrects it before it is painted.
 */
export function installDisclosureAnchor(
  scroller: HTMLElement,
  onLayoutChange: () => void,
): () => void {
  const onClick = (event: MouseEvent) => {
    const control = event.target instanceof Element
      ? event.target.closest<HTMLElement>("[aria-expanded]")
      : null;
    if (!control || !scroller.contains(control)) {
      return;
    }
    const before = control.getBoundingClientRect().top;
    const heightBefore = scroller.scrollHeight;
    requestAnimationFrame(() => {
      if (!control.isConnected || scroller.scrollHeight === heightBefore) {
        return;
      }
      onLayoutChange();
      const correction = disclosureScrollCorrection(
        before,
        control.getBoundingClientRect().top,
      );
      if (correction !== 0) {
        scroller.scrollTop += correction;
      }
    });
  };
  scroller.addEventListener("click", onClick);
  return () => {
    scroller.removeEventListener("click", onClick);
  };
}
