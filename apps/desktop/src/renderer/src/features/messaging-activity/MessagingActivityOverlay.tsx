import type { DesktopApi } from "../../lib/desktop-api";
import { MessagingActivityScreen } from "./MessagingActivityScreen";

/**
 * Top-level Messaging Activity surface, rendered inside the dedicated
 * Activity BrowserWindow (see
 * `apps/desktop/src/main/messaging-activity-window.ts` and
 * `MessagingActivityWindow.tsx`).
 *
 * Mirrors the v2 design's `screen === "activity"` mode (see
 * `docs/design/pwragent-v2/project/PwrAgnt v2.html` lines 116, 280).
 *
 * Chrome layout: single-row title-bar strip at the top (stoplight
 * gutter + brand + breadcrumb) above the activity body. The OS-native
 * traffic-light buttons handle window-close — no in-chrome Close
 * button is needed (and adding one would only create a redundant
 * affordance with non-standard placement).
 */
export function MessagingActivityOverlay(props: {
  desktopApi?: DesktopApi;
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
      </header>
      <div className="activity-content">
        <MessagingActivityScreen desktopApi={props.desktopApi} />
      </div>
    </section>
  );
}
