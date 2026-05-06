import { useEffect } from "react";
import { useDesktopApi } from "../../lib/desktop-api";
import { MessagingActivityOverlay } from "./MessagingActivityOverlay";

/**
 * Root component for the dedicated Messaging Activity BrowserWindow.
 *
 * Mounted by `main.tsx` when `window.location.hash === "#messaging-activity"`
 * — the spawn entry point is `showMessagingActivityWindow()` in the main
 * process. Closing the window goes through `window.close()`; the OS
 * window owns its own lifecycle and doesn't affect the main app window.
 *
 * The renderer-side document title is what macOS shows in the Window
 * menu (the BrowserWindow's `title` option gets overridden by
 * `<title>` in `index.html`, which is shared with the main window).
 * Set the document title on mount so this window reads "Messaging
 * Activity" while the main window keeps "PwrAgnt".
 */
export function MessagingActivityWindow() {
  const desktopApi = useDesktopApi();

  useEffect(() => {
    const previous = document.title;
    document.title = "Messaging Activity";
    return () => {
      document.title = previous;
    };
  }, []);

  return (
    <div className="messaging-activity-window">
      <MessagingActivityOverlay
        desktopApi={desktopApi}
        onClose={() => window.close()}
      />
    </div>
  );
}
