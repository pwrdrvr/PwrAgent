import { BrowserWindow } from "electron";
import { WINDOW_SHOW_THREAD_CHANNEL } from "../shared/ipc";
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import { subscribersForChannel } from "./window-channels";

export function requestShowThread(request: WindowShowThreadRequest): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_SHOW_THREAD_CHANNEL);

  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = subscribers.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      showWindow(focused);
      focusedSubscriber.send(WINDOW_SHOW_THREAD_CHANNEL, request);
      return;
    }
  }

  const fallback = subscribers[0];
  if (!fallback) {
    return;
  }
  const fallbackWindow = BrowserWindow.fromWebContents(fallback);
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    showWindow(fallbackWindow);
  }
  fallback.send(WINDOW_SHOW_THREAD_CHANNEL, request);
}

function showWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
}
