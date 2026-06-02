import { BrowserWindow } from "electron";
import { WINDOW_OPEN_NEW_THREAD_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

/**
 * Main → renderer push: tell the main-window renderer to open the
 * existing new-thread launchpad flow. Mirrors `requestOpenSettings`:
 * prefer the focused subscribed main window, otherwise fall back to
 * another registered main-window subscriber.
 */
export function requestOpenNewThread(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_OPEN_NEW_THREAD_CHANNEL);

  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = subscribers.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      focused.show();
      focusedSubscriber.send(WINDOW_OPEN_NEW_THREAD_CHANNEL);
      return;
    }
  }

  const fallback = subscribers[0];
  if (!fallback) {
    return;
  }
  const fallbackWindow = BrowserWindow.fromWebContents(fallback);
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    fallbackWindow.show();
  }
  fallback.send(WINDOW_OPEN_NEW_THREAD_CHANNEL);
}
