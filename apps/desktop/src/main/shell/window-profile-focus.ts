import type { BrowserWindow } from "electron";

/** A profile activation raises one window, preserving auxiliary/modal focus. */
export function selectWindowForProfileFocus(
  windows: readonly BrowserWindow[],
  focusedWindow: BrowserWindow | null,
  lastFocusedWindow: BrowserWindow | undefined,
  fallbackWindow: BrowserWindow,
  isShown: (window: BrowserWindow) => boolean,
): BrowserWindow {
  const available = windows.filter((window) => !window.isDestroyed());
  const preferred = [focusedWindow, lastFocusedWindow].find(
    (window): window is BrowserWindow =>
      Boolean(window && available.includes(window)),
  ) ?? fallbackWindow;
  return deepestShownModal(preferred, isShown);
}

/**
 * A sheet/modal can own the key window without becoming AppKit's main
 * window, so it need not have emitted Electron's window "focus" event.
 */
export function deepestShownModal<Window extends Pick<
  BrowserWindow,
  "getChildWindows" | "isDestroyed" | "isModal"
>>(
  window: Window,
  isShown: (window: Window) => boolean,
): Window {
  let preferred = window;
  for (;;) {
    const modal = (preferred.getChildWindows() as unknown as Window[]).find((child) =>
      !child.isDestroyed() && child.isModal() && isShown(child),
    );
    if (!modal) break;
    preferred = modal;
  }
  return preferred;
}
