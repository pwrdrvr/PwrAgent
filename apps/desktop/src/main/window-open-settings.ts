import { BrowserWindow } from "electron";
import { WINDOW_OPEN_SETTINGS_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

/**
 * Main → renderer push: tell the main-window renderer to open the
 * Settings overlay. Triggered from the PwrAgent → Settings… menu
 * item (macOS) or Help → Settings… (Linux/Windows). Settings is an
 * in-renderer overlay, not a separate BrowserWindow, so the main
 * process can't open it directly — it sends a message and the
 * renderer's App shell switches `mainView` to "settings".
 *
 * Picks the focused window first (typical case: the user just used
 * the menu so the main window IS the focused one), then falls back
 * to any main-window subscriber from the window-channel registry.
 * The fallback matters when the focused surface is a secondary
 * window (Messaging Activity, Logs, Changelog) — those don't host
 * the Settings overlay, so we have to dispatch to the actual main
 * window.
 */
export function requestOpenSettings(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_OPEN_SETTINGS_CHANNEL);

  // Prefer the focused main-window subscriber. If the user invoked
  // the menu while a secondary window was focused, fall through to
  // any registered main-window subscriber (typically just one).
  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = subscribers.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      // Bring the window forward in case it's behind a sibling.
      focused.show();
      focusedSubscriber.send(WINDOW_OPEN_SETTINGS_CHANNEL);
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
  fallback.send(WINDOW_OPEN_SETTINGS_CHANNEL);
}
