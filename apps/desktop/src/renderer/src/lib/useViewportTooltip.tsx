import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  isNativeDragInteractionActive,
  subscribeNativeDragInteraction,
} from "./native-drag-interaction";

const VIEWPORT_PADDING = 12;
/** Gap between the tooltip and the target element (above or below). */
const TOOLTIP_GAP = 10;

type TooltipState = {
  content: ReactNode;
  targetTop: number;
  targetBottom: number;
  targetCenter: number;
  /** Computed left after measure; undefined on the first paint. */
  left?: number;
  /** Computed top after measure; undefined on the first paint. */
  top?: number;
};

/**
 * Hook for portal-rendered tooltips that escape any clipping ancestor
 * (sidebar scroll regions, overflow:hidden chips, etc.) and clamp
 * themselves to viewport bounds. Use when CSS-pseudo-element tooltips
 * (`tooltip-target` + `data-tooltip` in app.css) get clipped by a
 * `overflow:hidden`/`overflow:auto` ancestor.
 *
 * Pattern adapted from ThreadContextPanel's railTooltip — same
 * measure-then-clamp two-pass render, same portal target.
 *
 * Usage:
 *   const { show, hide, tooltipNode } =
 *     useViewportTooltip({ className: "messaging-tooltip" });
 *   return (
 *     <span
 *       onMouseEnter={(e) => show(e.currentTarget, "Multi\nline\ntext")}
 *       onMouseLeave={hide}
 *       onFocus={(e) => show(e.currentTarget, "Multi\nline\ntext")}
 *       onBlur={hide}
 *     >
 *       …
 *       {tooltipNode}
 *     </span>
 *   );
 */
export function useViewportTooltip(options: {
  /** CSS class applied to the rendered tooltip element. */
  className: string;
}): {
  /**
   * DOM id stamped on the rendered tooltip. Point the trigger at it with
   * `aria-describedby={visible ? tooltipId : undefined}` when the tooltip
   * carries content a screen reader needs — a structured card is otherwise
   * sighted-only, since the portal sits outside the trigger's subtree and
   * nothing else references it. Gate on `visible`: an `aria-describedby`
   * naming an absent element is a dangling reference.
   */
  tooltipId: string;
  show: (target: HTMLElement, content: ReactNode) => void;
  /**
   * Replace the content of an already-visible tooltip in place (no-op
   * while hidden). Keeps the current position until the re-measure pass
   * settles, so live data updates don't blink the tooltip.
   */
  update: (content: ReactNode) => void;
  hide: () => void;
  /** Whether the tooltip is currently shown. */
  visible: boolean;
  tooltipNode: ReactNode;
} {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const tooltipId = useId();
  const [state, setState] = useState<TooltipState | undefined>(undefined);

  // Measure the rendered tooltip and clamp position so it stays in the
  // viewport and on the side of the target where it fits. The first
  // paint renders with left/top undefined (visibility hidden); content
  // updates re-measure from the already-visible position and only
  // reposition when the size actually changed, so the pass settles
  // without flicker.
  useLayoutEffect(() => {
    if (!state) {
      return;
    }
    const tooltipElement = tooltipRef.current;
    if (!tooltipElement) {
      return;
    }
    const rect = tooltipElement.getBoundingClientRect();
    const left = Math.min(
      window.innerWidth - rect.width - VIEWPORT_PADDING,
      Math.max(VIEWPORT_PADDING, state.targetCenter - rect.width / 2),
    );
    const fitsAbove =
      state.targetTop - rect.height - TOOLTIP_GAP >= VIEWPORT_PADDING;
    const top = fitsAbove
      ? state.targetTop - rect.height - TOOLTIP_GAP
      : state.targetBottom + TOOLTIP_GAP;
    if (state.left !== left || state.top !== top) {
      setState({ ...state, left, top });
    }
  }, [state]);

  const show = useCallback((target: HTMLElement, content: ReactNode): void => {
    if (isNativeDragInteractionActive()) {
      targetRef.current = null;
      setState(undefined);
      return;
    }
    const rect = target.getBoundingClientRect();
    targetRef.current = target;
    setState({
      content,
      targetTop: rect.top,
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2,
    });
  }, []);

  const update = useCallback((content: ReactNode): void => {
    setState((current) => (current ? { ...current, content } : current));
  }, []);

  const hide = useCallback((): void => {
    targetRef.current = null;
    setState(undefined);
  }, []);

  // A hover tooltip is shown on pointerenter/focus, but those handlers give
  // us no dismissal signal when the window loses focus (cmd-tab away leaves
  // the pointer "over" the chip, so no `mouseleave` fires) or when the list
  // scrolls underneath the position:fixed portal (the tooltip detaches from
  // its target and lingers). Tear it down when the viewport or an ancestor of
  // the target scrolls. A captured scroll from an unrelated pane must not
  // dismiss it — transcript auto-scrolls otherwise close sidebar tooltips.
  // Keyed on visibility so the measure pass doesn't resubscribe each render.
  const visible = state !== undefined;
  useEffect(() => {
    if (!visible) {
      return;
    }
    const unsubscribeNativeDrag = subscribeNativeDragInteraction((active) => {
      if (active) hide();
    });
    const onScroll = (event: Event): void => {
      const scrollTarget = event.target;
      const target = targetRef.current;
      if (
        scrollTarget === window
        || scrollTarget === document
        || (scrollTarget instanceof Node && target && scrollTarget.contains(target))
      ) {
        hide();
      }
    };
    window.addEventListener("blur", hide);
    window.addEventListener("scroll", onScroll, { capture: true });
    return () => {
      unsubscribeNativeDrag();
      window.removeEventListener("blur", hide);
      window.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [visible, hide]);

  const tooltipNode =
    state && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            id={tooltipId}
            className={options.className}
            style={{
              position: "fixed",
              left: state.left,
              top: state.top,
              visibility: state.left === undefined ? "hidden" : undefined,
            }}
          >
            {state.content}
          </div>,
          document.body,
        )
      : null;

  return { tooltipId, show, update, hide, visible, tooltipNode };
}
