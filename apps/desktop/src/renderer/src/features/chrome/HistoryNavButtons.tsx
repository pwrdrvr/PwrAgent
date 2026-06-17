import { ChevronLeftIcon, ChevronRightIcon } from "../../icons";
import { formatPrimaryAccel } from "../../lib/keyboard-accel";
import { useViewportTooltip } from "../../lib/useViewportTooltip";

export type HistoryNavControls = {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
};

/**
 * Browser-style Back/Forward pair for thread + search navigation. Lives at
 * the leading edge of the thread/search title bars (ThreadHeader and
 * ThreadPlaceholderHeader). The buttons only fire the callbacks — history
 * state is owned by `useNavigationHistory` in the app shell, and the
 * window-level shortcuts (⌘[/⌘], mouse back/forward buttons) are bound
 * once there via `useHistoryNavHotkeys`.
 */
export function HistoryNavButtons(props: HistoryNavControls) {
  // One shared viewport tooltip for both chips — only one is ever hovered at a
  // time. Custom (not native `title`) so it triggers instantly over the whole
  // button, clamps to the window edge, and reads like the rest of the chrome.
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const backTip = `Back  (${formatPrimaryAccel("[")})`;
  const forwardTip = `Forward  (${formatPrimaryAccel("]")})`;
  return (
    <div className="history-nav" role="group" aria-label="History navigation">
      <button
        type="button"
        className="history-nav__chip"
        aria-label="Back"
        data-testid="history-nav-back"
        disabled={!props.canGoBack}
        onClick={props.onBack}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, backTip)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => tooltip.show(event.currentTarget, backTip)}
        onBlur={tooltip.hide}
      >
        <ChevronLeftIcon size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="history-nav__chip"
        aria-label="Forward"
        data-testid="history-nav-forward"
        disabled={!props.canGoForward}
        onClick={props.onForward}
        onMouseEnter={(event) => tooltip.show(event.currentTarget, forwardTip)}
        onMouseLeave={tooltip.hide}
        onFocus={(event) => tooltip.show(event.currentTarget, forwardTip)}
        onBlur={tooltip.hide}
      >
        <ChevronRightIcon size={15} aria-hidden />
      </button>
      {tooltip.tooltipNode}
    </div>
  );
}
