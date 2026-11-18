import type { BrowserWindow } from "electron";
import { deepestShownModal } from "./window-profile-focus";

type RestorableWindow = Pick<
  BrowserWindow,
  "focus" | "getChildWindows" | "isDestroyed" | "isMinimized" | "isModal" | "restore"
>;

/**
 * The window to raise when a Dock click reactivates the app, or undefined to
 * leave AppKit's choice alone. The candidate is the window that was on top
 * when the app last resigned active, if it is still on screen.
 */
export function selectWindowToRestoreOnActivate<Window extends RestorableWindow>(
  windows: readonly Window[],
  topWindowAtResign: Window | undefined,
  isShown: (window: Window) => boolean,
): Window | undefined {
  if (
    !topWindowAtResign
    || topWindowAtResign.isDestroyed()
    || !windows.includes(topWindowAtResign)
    || !isShown(topWindowAtResign)
  ) {
    return undefined;
  }
  // A minimized window comes back only when nothing else is on screen;
  // otherwise the operator minimized it on purpose before switching away.
  if (
    topWindowAtResign.isMinimized()
    && windows.some((window) =>
      window !== topWindowAtResign
      && !window.isDestroyed()
      && isShown(window)
      && !window.isMinimized()
    )
  ) {
    return undefined;
  }
  return deepestShownModal(topWindowAtResign, isShown);
}

export interface ActivationWindowRestorer<Window extends RestorableWindow> {
  /** `app` `did-resign-active`: remember the window that was on top. */
  resignActive(lastFocusedWindow: Window | undefined): void;
  /** `app` `did-become-active`: the reactivation is over. */
  becomeActive(): void;
  /** A window closed; drop the reference so it cannot be raised. */
  forget(window: Window): void;
  /** `app` `activate` with windows open: raise the remembered window. */
  activate(): Window | undefined;
}

/**
 * Restores the window that was on top when the app lost focus.
 *
 * Measured on macOS with a real Dock press: `activate` fires before
 * `did-become-active` and before any window `focus` event, while
 * `getFocusedWindow()` already reports AppKit's pick. The live focus history
 * therefore cannot tell us which window was on top, so the restorer snapshots
 * it at `did-resign-active` and clears it at `did-become-active`. A Dock
 * click while the app is already active finds no snapshot and changes
 * nothing.
 */
export function createActivationWindowRestorer<Window extends RestorableWindow>(options: {
  getWindows: () => readonly Window[];
  getFocusedWindow: () => Window | null;
  isShown: (window: Window) => boolean;
}): ActivationWindowRestorer<Window> {
  let topWindowAtResign: Window | undefined;
  return {
    resignActive(lastFocusedWindow) {
      topWindowAtResign = lastFocusedWindow;
    },
    becomeActive() {
      topWindowAtResign = undefined;
    },
    forget(window) {
      if (topWindowAtResign === window) {
        topWindowAtResign = undefined;
      }
    },
    activate() {
      const target = selectWindowToRestoreOnActivate(
        options.getWindows(),
        topWindowAtResign,
        options.isShown,
      );
      topWindowAtResign = undefined;
      if (!target) {
        return undefined;
      }
      if (target.isMinimized()) {
        target.restore();
      }
      if (target !== options.getFocusedWindow()) {
        target.focus();
      }
      return target;
    },
  };
}
