import type { MessagingChannelKind } from "@pwragent/shared";
import { getDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { MessagingStatusBar } from "../messaging-status/MessagingStatusBar";
import { PanelToggleButtons } from "../chrome/PanelToggleButtons";
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
  desktopApi?: DesktopApi;
  title: string;
  onOpenMessagingActivity?: (platform?: MessagingChannelKind) => void;
  /**
   * Window panel toggles — mirrors ThreadHeader so the loading / empty
   * states share the same chrome (no layout shift, no stoplight overlap).
   */
  layout?: ThreadPlaceholderLayoutControls;
  /**
   * Wordmark + action buttons, shown left of the title when the sidebar is
   * hidden (macOS/Linux), exactly like the real thread header.
   */
  masthead?: MastheadActionsProps;
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
        <div className="thread-header__main">
          <div className="thread-header__eyebrow-row">
            <h2 className="thread-header__compact-title">{props.title}</h2>
          </div>
        </div>
        <div className="thread-header__chrome">
          {props.layout && !isWindows ? (
            <PanelToggleButtons
              sidebarOpen={props.layout.sidebarOpen}
              railOpen={props.layout.railOpen}
              onToggleSidebar={props.layout.onToggleSidebar}
              onToggleRail={props.layout.onToggleRail}
              railToggleDisabled={props.layout.railToggleDisabled}
            />
          ) : null}
          <MessagingStatusBar
            desktopApi={props.desktopApi}
            onOpenActivity={props.onOpenMessagingActivity}
          />
        </div>
      </div>
    </header>
  );
}
