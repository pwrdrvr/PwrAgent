import type { BrowserWindow } from "electron";
import { WINDOW_FOCUS_SYNC_CHANNEL } from "../shared/ipc";

export function attachWindowFocusSync(window: BrowserWindow): void {
  if (typeof window.on !== "function") {
    return;
  }

  window.on("focus", () => {
    if (
      typeof window.isDestroyed === "function" &&
      window.isDestroyed()
    ) {
      return;
    }

    if (typeof window.webContents.send !== "function") {
      return;
    }

    window.webContents.send(WINDOW_FOCUS_SYNC_CHANNEL, {
      focusedAt: Date.now(),
    });
  });
}
