import { BrowserWindow } from "electron";
import {
  WINDOW_OPEN_MAIN_VIEW_CHANNEL,
  type WindowOpenMainViewRequest,
} from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";
import { isFederationWindowWebContents } from "./window";

/**
 * Main → renderer push: tell a main-window renderer to show one of its own
 * screens, for View → Search Threads and View → Automations. Mirrors
 * `requestOpenSettings`: prefer the focused subscribed window, otherwise fall
 * back to another registered subscriber.
 *
 * Automations is a LOCAL surface, so it never lands in a remote federation
 * window, which hides it too. Search runs in whichever window the operator
 * is looking at — a federation window has its own search — so a focused
 * federation window keeps it, and only the fallback skips them.
 */
export function requestOpenMainView(view: WindowOpenMainViewRequest): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_OPEN_MAIN_VIEW_CHANNEL);
  const localSubscribers = subscribers.filter(
    (subscriber) => !isFederationWindowWebContents(subscriber),
  );
  const eligible = view === "search" ? subscribers : localSubscribers;

  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = eligible.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      focused.show();
      focusedSubscriber.send(WINDOW_OPEN_MAIN_VIEW_CHANNEL, view);
      return;
    }
  }

  const fallback = localSubscribers[0];
  if (!fallback) {
    return;
  }
  const fallbackWindow = BrowserWindow.fromWebContents(fallback);
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    fallbackWindow.show();
  }
  fallback.send(WINDOW_OPEN_MAIN_VIEW_CHANNEL, view);
}
