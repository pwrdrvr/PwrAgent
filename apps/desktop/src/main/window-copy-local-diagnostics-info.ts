import { BrowserWindow } from "electron";
import { WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

/** Ask the focused local renderer to copy diagnostics for its selected thread. */
export function requestCopyLocalDiagnosticsInfo(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(
    WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL,
  );

  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = subscribers.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      focusedSubscriber.send(WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL);
      return;
    }
  }

  subscribers[0]?.send(WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL);
}
