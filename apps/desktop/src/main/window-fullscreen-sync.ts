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
  // happened — e.g. a dev HMR reload or a renderer-crash reload that keeps
  // the same (still-fullscreen) BrowserWindow. Re-emit the current state on
  // every load so `<html data-fullscreen>` matches reality instead of the
  // non-fullscreen default the renderer bootstraps with.
  //
  // This stands in for a synchronous pre-paint bootstrap (like the
  // data-platform / data-theme `process.argv` path): we deliberately don't
  // have one. argv is frozen at window creation — where the window is never
  // fullscreen — so it can't describe a later transition, and a correct
  // synchronous read would need a blocking `ipcRenderer.sendSync`. The cost
  // (a sub-frame over-reservation on reload-while-fullscreen, never a broken
  // layout, never on a normal launch) doesn't justify that.
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
