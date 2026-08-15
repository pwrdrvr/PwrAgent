import { BrowserWindow } from "electron";
import { WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";
import { isFederationWindowWebContents } from "./window";

/** Ask the focused renderer to copy diagnostics for its selected thread. */
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

  const fallback = subscribers.find(
    (subscriber) => !isFederationWindowWebContents(subscriber),
  ) ?? subscribers[0];
  fallback?.send(WINDOW_COPY_LOCAL_DIAGNOSTICS_INFO_CHANNEL);
}
