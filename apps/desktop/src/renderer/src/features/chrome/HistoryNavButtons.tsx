import { ChevronLeftIcon, ChevronRightIcon } from "../../icons";
import { formatPrimaryAccel } from "../../lib/keyboard-accel";

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
  return (
    <div className="history-nav" role="group" aria-label="History navigation">
      <button
        type="button"
        className="history-nav__chip"
        aria-label="Back"
        title={`Back  (${formatPrimaryAccel("[")})`}
        disabled={!props.canGoBack}
        onClick={props.onBack}
      >
        <ChevronLeftIcon size={15} aria-hidden />
      </button>
      <button
        type="button"
        className="history-nav__chip"
        aria-label="Forward"
        title={`Forward  (${formatPrimaryAccel("]")})`}
        disabled={!props.canGoForward}
        onClick={props.onForward}
      >
        <ChevronRightIcon size={15} aria-hidden />
      </button>
    </div>
  );
}
