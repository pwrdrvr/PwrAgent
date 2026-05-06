import { useDesktopApi } from "../../lib/desktop-api";
import { MessagingActivityOverlay } from "./MessagingActivityOverlay";

/**
 * Root component for the dedicated Messaging Activity BrowserWindow.
 *
 * Mounted by `main.tsx` when `window.location.hash === "#messaging-activity"`
 * — the spawn entry point is `showMessagingActivityWindow()` in the main
 * process. Closing the window goes through `window.close()`; the OS
 * window owns its own lifecycle and doesn't affect the main app window.
 */
export function MessagingActivityWindow() {
  const desktopApi = useDesktopApi();
  return (
    <div className="messaging-activity-window">
      <MessagingActivityOverlay
        desktopApi={desktopApi}
        onClose={() => window.close()}
      />
    </div>
  );
}
