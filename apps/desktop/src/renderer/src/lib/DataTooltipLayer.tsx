import { useCallback, useEffect, useRef } from "react";
import { useViewportTooltip } from "./useViewportTooltip";

/**
 * The declarative tooltip: `className="… tooltip-target"` plus
 * `data-tooltip={text}`. One layer per renderer root draws all of them.
 */
export const DATA_TOOLTIP_SELECTOR = ".tooltip-target[data-tooltip]";

const DESCRIBED_BY = "aria-describedby";

type Anchor = {
  element: HTMLElement;
  /** What opened it, which decides what closes it: a pointer leaving does not
   *  close a keyboard-focus tooltip, and a blur does not close a hovered one. */
  via: "pointer" | "focus";
  /** Whether this layer wrote the anchor's `aria-describedby`, so it only ever
   *  removes a reference it added. */
  describedBy: boolean;
};

function tooltipTargetAt(node: EventTarget | null): HTMLElement | null {
  return node instanceof Element
    ? node.closest<HTMLElement>(DATA_TOOLTIP_SELECTOR)
    : null;
}

function isFocusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Draws every `.tooltip-target[data-tooltip]` tooltip in a portal on
 * `document.body`, through the same `useViewportTooltip` the hand-wired
 * tooltips use.
 *
 * These were an `::after` pseudo-element, and a pseudo-element is painted
 * inside its host: it is clipped by every `overflow` ancestor and stacked
 * inside every stacking context the host sits in. The composer's toolbar sits
 * in the main pane beside the sidebar, so a toggle near the pane's left edge
 * drew its centred tooltip under the left bar, and each fix to date moved one
 * control onto the portal or nudged one tooltip's x. No CSS on the host can
 * lift a pseudo-element out of its ancestors' layers; only a different parent
 * can. Delegating from the document gives every declarative tooltip — the
 * existing ones and the next one someone writes — that parent, without
 * threading a hook through each control.
 *
 * Hover and keyboard focus open it, matching the old `:hover` and
 * `:focus-visible` rules. A focus that a click caused does not, so a clicked
 * toggle does not pin its tooltip over the control beside it.
 */
export function DataTooltipLayer() {
  const { show, hide, update, visible, tooltipId, tooltipNode } =
    useViewportTooltip({ className: "viewport-tooltip data-tooltip-layer" });
  const anchorRef = useRef<Anchor | null>(null);
  const contentObserverRef = useRef<MutationObserver | null>(null);

  const release = useCallback((): void => {
    contentObserverRef.current?.disconnect();
    contentObserverRef.current = null;
    const anchor = anchorRef.current;
    anchorRef.current = null;
    if (
      anchor?.describedBy
      && anchor.element.getAttribute(DESCRIBED_BY) === tooltipId
    ) {
      anchor.element.removeAttribute(DESCRIBED_BY);
    }
  }, [tooltipId]);

  const close = useCallback((): void => {
    release();
    hide();
  }, [hide, release]);

  // The hook also hides on its own — a press, Escape, a scroll, the anchor
  // leaving the document. Forget the anchor then too, or the next hover of the
  // same control would read as a move inside it and open nothing.
  useEffect(() => {
    if (!visible) {
      release();
    }
  }, [release, visible]);

  useEffect(() => {
    const open = (element: HTMLElement, via: Anchor["via"]): void => {
      const content = element.getAttribute("data-tooltip");
      if (!content) {
        return;
      }
      release();
      // A control that already names its own description keeps it; this layer
      // only fills the gap.
      const describedBy = !element.hasAttribute(DESCRIBED_BY);
      if (describedBy) {
        element.setAttribute(DESCRIBED_BY, tooltipId);
      }
      anchorRef.current = { element, via, describedBy };
      // Controls rewrite their tooltip while it shows ("Talk to this thread"
      // becomes "End voice"), which the `::after` picked up for free.
      const observer = new MutationObserver(() => {
        const next = element.matches(DATA_TOOLTIP_SELECTOR)
          ? element.getAttribute("data-tooltip")
          : null;
        if (next) {
          update(next);
        } else {
          close();
        }
      });
      observer.observe(element, {
        attributes: true,
        attributeFilter: ["class", "data-tooltip"],
      });
      contentObserverRef.current = observer;
      show(element, content);
    };

    // Leaving a hovered control falls back to the one holding keyboard focus,
    // as the `:focus-visible` rule kept that one showing underneath.
    const closeOrRestoreFocus = (): void => {
      const focused = document.activeElement;
      const focusTarget = tooltipTargetAt(focused);
      if (focused && focusTarget && isFocusVisible(focused)) {
        open(focusTarget, "focus");
        return;
      }
      close();
    };

    // `pointerover`/`pointerout` bubble, and Chromium dispatches them to a
    // disabled button, whose explanation ("why is Auto-fix off?") is often the
    // reason the tooltip exists. A move between one target's own children is
    // neither an enter nor a leave.
    const onPointerOver = (event: PointerEvent): void => {
      const target = tooltipTargetAt(event.target);
      if (!target || target === tooltipTargetAt(event.relatedTarget)) {
        return;
      }
      open(target, "pointer");
    };
    const onPointerOut = (event: PointerEvent): void => {
      const target = tooltipTargetAt(event.target);
      if (!target || target === tooltipTargetAt(event.relatedTarget)) {
        return;
      }
      if (anchorRef.current?.element === target && anchorRef.current.via === "pointer") {
        closeOrRestoreFocus();
      }
    };
    // `:has(:focus-visible)` covered a target whose focusable part is a child,
    // like a reference chip's remove button; `closest` covers the same.
    const onFocusIn = (event: FocusEvent): void => {
      const target = tooltipTargetAt(event.target);
      if (!target || !(event.target instanceof Element) || !isFocusVisible(event.target)) {
        return;
      }
      open(target, "focus");
    };
    const onFocusOut = (event: FocusEvent): void => {
      const target = tooltipTargetAt(event.target);
      if (
        !target
        || anchorRef.current?.element !== target
        || anchorRef.current.via !== "focus"
        || target === tooltipTargetAt(event.relatedTarget)
      ) {
        return;
      }
      close();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerout", onPointerOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerout", onPointerOut);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, [close, release, show, tooltipId, update]);

  useEffect(() => release, [release]);

  return tooltipNode;
}
