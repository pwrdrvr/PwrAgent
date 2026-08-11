import { BrowserWindow, type WebContents } from "electron";
import { WINDOW_SHOW_THREAD_CHANNEL } from "../shared/ipc";
import type { WindowShowThreadRequest } from "../shared/window-show-thread";
import { subscribersForChannel } from "./window-channels";

export type RequestShowThreadOptions = {
  /**
   * Window the caller already knows holds this thread. A thread key alone
   * does not say which window can show it: a peer's thread exists only in the
   * federation window fronting that peer (or a main window that pinned it),
   * so falling through to the focused-or-first window sends a remote thread
   * somewhere it was never mounted.
   */
  preferWebContents?: WebContents;
};

export function requestShowThread(
  request: WindowShowThreadRequest,
  options: RequestShowThreadOptions = {},
): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_SHOW_THREAD_CHANNEL);

  const preferred = options.preferWebContents;
  if (preferred && !preferred.isDestroyed() && subscribers.includes(preferred)) {
    const preferredWindow = BrowserWindow.fromWebContents(preferred);
    if (preferredWindow && !preferredWindow.isDestroyed()) {
      showWindow(preferredWindow);
    }
    preferred.send(WINDOW_SHOW_THREAD_CHANNEL, request);
    return;
  }

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
