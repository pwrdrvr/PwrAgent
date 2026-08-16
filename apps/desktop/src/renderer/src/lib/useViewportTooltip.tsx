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
/**
 * Short entry delay for dense metadata tooltips. It filters incidental pointer
 * crossings without requiring the pointer to remain perfectly stationary.
 */
export const TOOLTIP_HOVER_DELAY_MS = 250;

/**
 * Strips that own the top of a window: the Windows custom title bar, and the
 * macOS stoplight gutters (`padding-left: 80px` is the traffic lights' room).
 * All three are `-webkit-app-region: drag`.
 *
 * Deliberately not every drag region. `.thread-header` and
 * `.settings-titlebar` drag too, but they sit to the RIGHT of the stoplights
 * and are content strips — flooring tooltips below them would push half the
 * sidebar's tooltips down the window to protect nothing.
 */
const TOP_WINDOW_CHROME_SELECTORS = [
  ".app-titlebar",
  ".sidebar__masthead",
  ".settings-nav__masthead",
];

function tooltipViewportTop(): number {
  // On Windows the fixed custom title bar occupies the top of the renderer,
  // while `.app-shell` begins immediately below it. Portal tooltips live on
  // document.body, so the raw viewport top would let them render underneath
  // that higher title-bar layer. The shell boundary is also zero on platforms
  // without the custom strip, preserving the ordinary viewport behavior.
  const appShell = document.querySelector<HTMLElement>(".app-shell");
  const appShellTop = appShell?.getBoundingClientRect().top ?? 0;
  let viewportTop = Math.max(VIEWPORT_PADDING, appShellTop + VIEWPORT_PADDING);
  // macOS reserves its traffic lights INSIDE the renderer (`titleBarStyle:
  // "hiddenInset"`), so `.app-shell` starts at 0 and the clamp above happily
  // parks a tooltip on top of the close/minimize/zoom buttons and the wordmark
  // beside them. Nothing about that region is hoverable content — it is native
  // window chrome that a tooltip must never cover.
  for (const selector of TOP_WINDOW_CHROME_SELECTORS) {
    const chrome = document.querySelector<HTMLElement>(selector);
    if (!chrome) {
      continue;
    }
    const rect = chrome.getBoundingClientRect();
    // Only a strip actually anchored to the top of the window is a floor. One
    // scrolled or laid out further down is ordinary content.
    if (rect.height > 0 && rect.top <= appShellTop + VIEWPORT_PADDING) {
      viewportTop = Math.max(viewportTop, rect.bottom);
    }
  }
  return viewportTop;
}

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

type DelayedTooltipContent = ReactNode | (() => ReactNode);

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
   * Arm a tooltip after a short delay from pointer entry. Pointer movement does
   * not restart the delay; leaving the target should call `hide` to cancel it.
   */
  showAfterDelay: (
    target: HTMLElement,
    content: DelayedTooltipContent,
  ) => void;
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
  const hoverDelayTimerRef = useRef<number | null>(null);
  const tooltipId = useId();
  const [state, setState] = useState<TooltipState | undefined>(undefined);
  const [delayPending, setDelayPending] = useState(false);

  const clearHoverDelay = useCallback((): void => {
    if (hoverDelayTimerRef.current === null) {
      return;
    }
    window.clearTimeout(hoverDelayTimerRef.current);
    hoverDelayTimerRef.current = null;
  }, []);

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
    const viewportTop = tooltipViewportTop();
    const viewportBottom = window.innerHeight - VIEWPORT_PADDING;
    const aboveTop = state.targetTop - rect.height - TOOLTIP_GAP;
    const belowTop = state.targetBottom + TOOLTIP_GAP;
    const fitsAbove = aboveTop >= viewportTop;
    const fitsBelow = belowTop + rect.height <= viewportBottom;
    let top: number;
    if (fitsAbove) {
      top = aboveTop;
    } else if (fitsBelow) {
      top = belowTop;
    } else {
      const availableAbove = Math.max(
        0,
        state.targetTop - TOOLTIP_GAP - viewportTop,
      );
      const availableBelow = Math.max(
        0,
        viewportBottom - state.targetBottom - TOOLTIP_GAP,
      );
      const preferredTop =
        availableAbove >= availableBelow ? aboveTop : belowTop;
      const maximumTop = Math.max(viewportTop, viewportBottom - rect.height);
      top = Math.min(maximumTop, Math.max(viewportTop, preferredTop));
    }
    if (state.left !== left || state.top !== top) {
      setState({ ...state, left, top });
    }
  }, [state]);

  const show = useCallback((target: HTMLElement, content: ReactNode): void => {
    clearHoverDelay();
    setDelayPending(false);
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
  }, [clearHoverDelay]);

  const showAfterDelay = useCallback(
    (target: HTMLElement, content: DelayedTooltipContent): void => {
      if (targetRef.current === target) {
        return;
      }
      clearHoverDelay();
      targetRef.current = target;
      setDelayPending(true);
      hoverDelayTimerRef.current = window.setTimeout(() => {
        hoverDelayTimerRef.current = null;
        setDelayPending(false);
        show(target, typeof content === "function" ? content() : content);
      }, TOOLTIP_HOVER_DELAY_MS);
    },
    [clearHoverDelay, show],
  );

  const update = useCallback((content: ReactNode): void => {
    setState((current) => (current ? { ...current, content } : current));
  }, []);

  const hide = useCallback((): void => {
    clearHoverDelay();
    setDelayPending(false);
    targetRef.current = null;
    setState(undefined);
  }, [clearHoverDelay]);

  useEffect(() => clearHoverDelay, [clearHoverDelay]);

  // A hover tooltip is armed or shown on pointerenter/focus, but those handlers give
  // us no dismissal signal when the window loses focus (cmd-tab away leaves
  // the pointer "over" the chip, so no `mouseleave` fires) or when the list
  // scrolls underneath the position:fixed portal (the tooltip detaches from
  // its target and lingers). Tear it down when the viewport or an ancestor of
  // the target scrolls. A captured scroll from an unrelated pane must not
  // dismiss it — transcript auto-scrolls otherwise close sidebar tooltips.
  // Keyed on activity so the measure pass doesn't resubscribe each render.
  const visible = state !== undefined;
  const active = delayPending || visible;
  useEffect(() => {
    if (!active) {
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
  }, [active, hide]);

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

  return {
    tooltipId,
    show,
    showAfterDelay,
    update,
    hide,
    visible,
    tooltipNode,
  };
}
