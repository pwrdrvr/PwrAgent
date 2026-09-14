import type { App, BrowserWindow } from "electron";
import { WINDOW_FRAME_SYNC_CHANNEL, type WindowFrameState } from "../shared/ipc";

/**
 * Mirror the window's maximize state into its renderer.
 *
 * Two Linux surfaces draw from it and neither can ask the DOM: the painted
 * caption button picks its glyph from it, and the window hairline — the edge
 * Electron gives a frameless Linux window none of — has to disappear once the
 * frame is flush with the screen.
 *
 * The glyph follows the WINDOW, not the last button press. A `maximize()` the
 * window manager declines fires nothing, and a maximize from somewhere else
 * entirely — a double-click on the drag strip, Super+Up, a tiling keybind —
 * fires all the same. Only the window's own events describe both.
 *
 * Attached to EVERY window kind (`installWindowFrameSync` in index.ts), not
 * only the shell window that paints a strip: the hairline is painted by every
 * window on Linux, including the auxiliary ones that keep the native frame,
 * and a window whose state never arrives would keep its hairline while
 * maximized.
 */
export function attachWindowFrameSync(window: BrowserWindow): void {
  if (typeof window.on !== "function") {
    return;
  }

  const send = (): void => {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      return;
    }
    if (typeof window.webContents?.send !== "function") {
      return;
    }
    window.webContents.send(WINDOW_FRAME_SYNC_CHANNEL, {
      maximized:
        typeof window.isMaximized === "function" ? window.isMaximized() : false,
    } satisfies WindowFrameState);
  };

  window.on("maximize", send);
  window.on("unmaximize", send);

  // The renderer can mount AFTER a maximize has already happened — a window
  // restored maximized from its saved bounds, a dev HMR reload, a
  // renderer-crash reload that keeps the same BrowserWindow. Re-emit on every
  // load so the glyph and the hairline match reality instead of the restored
  // default the renderer bootstraps with. Same reasoning (and same lack of a
  // synchronous pre-paint bootstrap) as `window-fullscreen-sync.ts`: argv is
  // frozen at construction and cannot describe a later transition.
  if (typeof window.webContents?.on === "function") {
    window.webContents.on("did-finish-load", send);
  }
}

/** The slice of `app` the installer subscribes to. */
export type WindowCreatingApp = Pick<App, "on">;

/**
 * Push maximize state to every window's renderer, on the one platform that
 * draws from it.
 *
 * Hooked on `browser-window-created` rather than called from each creator: the
 * hairline in `app.css` is painted by every window on Linux — the frameless
 * shell window AND the auxiliary ones that keep the native frame, whose GTK
 * border vanishes against our own dark surfaces — so a window that never
 * reported would keep its hairline while maximized. There are a dozen window
 * creators in this directory; there is one of these.
 */
export function installWindowFrameSync(
  app: WindowCreatingApp,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux") return;

  app.on("browser-window-created", (_event, window) => {
    attachWindowFrameSync(window);
  });
}
