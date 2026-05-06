import { useEffect } from "react";
import { useDesktopApi } from "../../lib/desktop-api";
import { MessagingActivityScreen } from "./MessagingActivityScreen";

/**
 * Root component for the dedicated Messaging Activity BrowserWindow.
 *
 * Mounted by `main.tsx` when `window.location.hash === "#messaging-activity"`.
 * The spawn entry point is `showMessagingActivityWindow()` in the main
 * process. Window-close goes through the OS traffic-light buttons; no
 * in-chrome Close button is needed.
 *
 * Renders its own chrome here (title-bar strip with brand + breadcrumb)
 * above the activity body. Mirrors the v2 design's `screen === "activity"`
 * mode (see `docs/design/pwragent-v2/project/PwrAgnt v2.html` lines
 * 116, 280).
 */
export function MessagingActivityWindow() {
  const desktopApi = useDesktopApi();

  // The renderer-side document title is what macOS shows in the
  // Window menu (the BrowserWindow's `title` option gets overridden
  // by `<title>` in `index.html`, which is shared with the main
  // window). Set it on mount so this window reads "Messaging
  // Activity" while the main window keeps "PwrAgnt".
  useEffect(() => {
    document.title = "Messaging Activity";
  }, []);

  return (
    <div className="messaging-activity-window">
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
          <MessagingActivityScreen desktopApi={desktopApi} />
        </div>
      </section>
    </div>
  );
}
