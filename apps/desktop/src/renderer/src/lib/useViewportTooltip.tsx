import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const VIEWPORT_PADDING = 12;
/** Gap between the tooltip and the target element (above or below). */
const TOOLTIP_GAP = 10;

type TooltipState = {
  text: string;
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
  show: (target: HTMLElement, text: string) => void;
  hide: () => void;
  tooltipNode: ReactNode;
} {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<TooltipState | undefined>(undefined);

  // After the tooltip first paints (with left/top undefined → visibility
  // hidden), measure it and clamp position so it stays in the viewport
  // and on the side of the target where it fits.
  useLayoutEffect(() => {
    if (!state || state.left !== undefined) {
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
    setState({ ...state, left, top });
  }, [state]);

  const show = useCallback((target: HTMLElement, text: string): void => {
    const rect = target.getBoundingClientRect();
    setState({
      text,
      targetTop: rect.top,
      targetBottom: rect.bottom,
      targetCenter: rect.left + rect.width / 2,
    });
  }, []);

  const hide = useCallback((): void => {
    setState(undefined);
  }, []);

  const tooltipNode =
    state && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={tooltipRef}
            role="tooltip"
            className={options.className}
            style={{
              position: "fixed",
              left: state.left,
              top: state.top,
              visibility: state.left === undefined ? "hidden" : undefined,
            }}
          >
            {state.text}
          </div>,
          document.body,
        )
      : null;

  return { show, hide, tooltipNode };
}
