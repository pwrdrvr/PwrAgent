import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingActivityScreen } from "./MessagingActivityScreen";

/**
 * Top-level Messaging Activity surface. Mounts as its own full-screen
 * overlay (`app-shell__activity-layer`) — NOT as a settings section.
 *
 * Routes here from:
 * - The title-bar `MessagingStatusBar` chip click in `ThreadView`
 * - The same chip when shown inside the Settings overlay's title-bar
 *   strip (we close Settings as we open Activity at the App level)
 *
 * Mirrors the v2 design's `screen === "activity"` mode (see
 * `docs/design/pwragent-v2/project/PwrAgnt v2.html` lines 116, 280).
 *
 * Chrome layout: a single-row title-bar strip at the top (stoplight
 * gutter + brand + breadcrumb + Close) above the activity body.
 */
export function MessagingActivityOverlay(props: {
  desktopApi?: DesktopApi;
  onClose: () => void;
}) {
  return (
    <section
      aria-label="Messaging activity"
      className="activity-screen"
    >
      <header className="activity-titlebar">
        <p className="activity-titlebar__brand">
          Pwr<span className="activity-titlebar__brand-accent">Agent</span>
        </p>
        <div className="activity-titlebar__breadcrumb">
          <span className="activity-titlebar__eyebrow">Messaging</span>
          <span aria-hidden="true" className="activity-titlebar__separator">
            ›
          </span>
          <span className="activity-titlebar__current">Activity</span>
        </div>
        <div className="activity-titlebar__spacer" />
        <button
          className="activity-titlebar__close"
          type="button"
          onClick={props.onClose}
        >
          <span aria-hidden="true">✕</span> Close
        </button>
      </header>
      <div className="activity-content">
        <MessagingActivityScreen desktopApi={props.desktopApi} />
      </div>
    </section>
  );
}
