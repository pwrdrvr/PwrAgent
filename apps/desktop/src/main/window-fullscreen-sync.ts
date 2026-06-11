import type { BrowserWindow } from "electron";
import { WINDOW_FULLSCREEN_SYNC_CHANNEL } from "../shared/ipc";

/**
 * Mirror native fullscreen state into the renderer.
 *
 * On macOS the OS hides the traffic-light stoplights when a window goes
 * fullscreen, but the renderer reserves a fixed left inset for them (see
 * the `.sidebar__masthead` / `.thread-header__masthead` rules in app.css).
 * Without telling the renderer about the transition, that inset stays put
 * and leaves a dead gap where the lights used to be. We forward the
 * `enter-full-screen` / `leave-full-screen` events so the renderer can
 * toggle `<html data-fullscreen>` and collapse the inset.
 */
export function attachWindowFullscreenSync(window: BrowserWindow): void {
  if (typeof window.on !== "function") {
    return;
  }

  const send = (isFullScreen: boolean): void => {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      return;
    }
    if (typeof window.webContents?.send !== "function") {
      return;
    }
    window.webContents.send(WINDOW_FULLSCREEN_SYNC_CHANNEL, { isFullScreen });
  };

  window.on("enter-full-screen", () => send(true));
  window.on("leave-full-screen", () => send(false));

  // The renderer can mount AFTER a fullscreen transition has already
  // happened — a dev HMR reload while fullscreen, or the window being
  // restored into fullscreen. Re-emit the current state on every load so
  // `<html data-fullscreen>` matches reality instead of the non-fullscreen
  // default the renderer bootstraps with.
  if (typeof window.webContents?.on === "function") {
    window.webContents.on("did-finish-load", () => {
      send(
        typeof window.isFullScreen === "function"
          ? window.isFullScreen()
          : false,
      );
    });
  }
}
