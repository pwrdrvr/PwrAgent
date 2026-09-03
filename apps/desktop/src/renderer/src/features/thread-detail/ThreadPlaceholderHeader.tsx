import type { MessagingChannelKind } from "@pwragent/shared";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { StarMapIcon } from "../../icons/StarMapIcon";
import { PanelToggleButtons } from "../chrome/PanelToggleButtons";
import type { StarMapToggleControls } from "./ThreadHeader";
import {
  HistoryNavButtons,
  type HistoryNavControls,
} from "../chrome/HistoryNavButtons";
import { MastheadActions, type MastheadActionsProps } from "../chrome/MastheadActions";

type ThreadPlaceholderLayoutControls = {
  sidebarOpen: boolean;
  railOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRail: () => void;
  /** Grey out the rail toggle for views with no context rail (search). */
  railToggleDisabled?: boolean;
};

type ThreadPlaceholderHeaderProps = {
  backendLabel?: string;
  contextLabel?: string;
  desktopApi?: DesktopApi;
  projectLabel?: string;
  title: string;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  onOpenMessagingSettings?: () => void;
  /**
   * Window panel toggles — mirrors ThreadHeader so the loading / empty
   * states share the same chrome (no layout shift, no stoplight overlap),
   * on every platform.
   */
  layout?: ThreadPlaceholderLayoutControls;
  /** Star Map toggle, mirroring ThreadHeader so the chrome never shifts. */
  starMap?: StarMapToggleControls;
  /**
   * Wordmark + action buttons, shown left of the title when the sidebar is
   * hidden (macOS/Linux), exactly like the real thread header.
   */
  masthead?: MastheadActionsProps;
  /**
   * Browser-style Back/Forward, mirroring ThreadHeader so search and the
   * loading / empty states keep the affordance in the same spot.
   */
  history?: HistoryNavControls;
};

/**
 * Stand-in header for the lazy-load ("Loading…") and no-selection
 * ("Pick a Thread") states. Mirrors {@link ThreadHeader}'s top-row layout so
 * the chrome (masthead when the sidebar is hidden, panel toggles, MSG) is
 * identical — the startup flash and the empty state no longer render a
 * broken header jammed under the macOS traffic lights.
 */
export function ThreadPlaceholderHeader(props: ThreadPlaceholderHeaderProps) {
  const isWindows = getDesktopApi()?.platform === "win32";
  const sidebarHidden = props.layout ? !props.layout.sidebarOpen : false;
  const showMasthead = sidebarHidden && !isWindows && Boolean(props.masthead);
  const starMapTooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const starMapLabel = "Open Star Map";

  return (
    <header className="thread-header thread-header--placeholder">
      <div className="thread-header__top">
        {showMasthead && props.masthead ? (
          <div className="thread-header__masthead">
            <p className="sidebar__brand">
              Pwr<span className="sidebar__brand-accent">Agent</span>
            </p>
            <MastheadActions {...props.masthead} />
          </div>
        ) : null}
        {props.history ? <HistoryNavButtons {...props.history} /> : null}
        <div className="thread-header__main">
          <div className="thread-header__eyebrow-row">
            <div className="thread-header__breadcrumb">
              {props.projectLabel ? (
                <>
                  <span
                    className="thread-header__eyebrow"
                    title={props.projectLabel}
                  >
                    {props.projectLabel}
                  </span>
                  <span aria-hidden="true" className="thread-header__separator">
                    ›
                  </span>
                </>
              ) : null}
              <h2 className="thread-header__compact-title">{props.title}</h2>
            </div>
            {props.backendLabel ? (
              <span className="chip chip--backend">{props.backendLabel}</span>
            ) : null}
            {props.contextLabel ? (
              <span className="thread-row__chip" title={props.contextLabel}>
                {props.contextLabel}
              </span>
            ) : null}
          </div>
        </div>
        <div className="thread-header__chrome">
          {props.layout ? (
            <PanelToggleButtons
              sidebarOpen={props.layout.sidebarOpen}
              railOpen={props.layout.railOpen}
              onToggleSidebar={props.layout.onToggleSidebar}
              onToggleRail={props.layout.onToggleRail}
              railToggleDisabled={props.layout.railToggleDisabled}
            />
          ) : null}
          {props.starMap ? (
            <button
              type="button"
              className="thread-header__star-map-toggle"
              aria-label={starMapLabel}
              onClick={() => {
                starMapTooltip.hide();
                props.starMap?.onOpen();
              }}
              onMouseEnter={(event) =>
                starMapTooltip.show(event.currentTarget, starMapLabel)
              }
              onMouseLeave={starMapTooltip.hide}
              onFocus={(event) =>
                starMapTooltip.show(event.currentTarget, starMapLabel)
              }
              onBlur={starMapTooltip.hide}
            >
              <StarMapIcon size={14} />
            </button>
          ) : null}
          {starMapTooltip.tooltipNode}
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
            onOpenSettings={props.onOpenMessagingSettings}
          />
        </div>
      </div>
    </header>
  );
}
