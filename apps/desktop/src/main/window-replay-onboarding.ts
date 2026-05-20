import { BrowserWindow } from "electron";
import { WINDOW_REPLAY_ONBOARDING_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";

/**
 * Main → renderer push: re-open the first-run onboarding wizard from
 * the Help menu. Mirrors `requestOpenSettings` — the wizard is an
 * in-renderer overlay, so we dispatch via the existing window-channel
 * registry rather than spinning a new BrowserWindow.
 *
 * Does NOT touch the per-profile `onboarding.completed` flag. Re-entry
 * is transient — the user can close the wizard with no persistence
 * change.
 */
export function requestReplayOnboarding(): void {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_REPLAY_ONBOARDING_CHANNEL);

  if (focused && !focused.isDestroyed()) {
    const focusedSubscriber = subscribers.find(
      (subscriber) => subscriber === focused.webContents,
    );
    if (focusedSubscriber) {
      focused.show();
      focusedSubscriber.send(WINDOW_REPLAY_ONBOARDING_CHANNEL);
      return;
    }
  }

  const fallback = subscribers[0];
  if (!fallback) return;
  const fallbackWindow = BrowserWindow.fromWebContents(fallback);
  if (fallbackWindow && !fallbackWindow.isDestroyed()) {
    fallbackWindow.show();
  }
  fallback.send(WINDOW_REPLAY_ONBOARDING_CHANNEL);
}
