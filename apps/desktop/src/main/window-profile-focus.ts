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
  let preferred = [focusedWindow, lastFocusedWindow].find(
    (window): window is BrowserWindow =>
      Boolean(window && available.includes(window)),
  ) ?? fallbackWindow;
  // A sheet/modal can own the key window without becoming AppKit's main
  // window, so it need not have emitted Electron's window "focus" event.
  for (;;) {
    const modal = preferred.getChildWindows().find((child) =>
      !child.isDestroyed() && child.isModal() && isShown(child),
    );
    if (!modal) break;
    preferred = modal;
  }
  return preferred;
}
