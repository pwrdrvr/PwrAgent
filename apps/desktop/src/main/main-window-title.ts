import type { BrowserWindow } from "electron";

/**
 * The product name as it appears in the OS window title and the macOS
 * Window menu. This is the ONE place the shell window's name is spelled;
 * everything else derives from it.
 *
 * It deliberately does NOT come from the checkout directory, the repo
 * folder, or `process.cwd()` — a window titled after wherever the app
 * happens to be running from is meaningless to an operator and drifts
 * per machine. It also must not be duplicated as a literal elsewhere:
 * the renderer's `index.html` carried its own stale copy (`PwrAgnt`,
 * the pre-rename spelling) that silently won over the main-process
 * title on load. See `lockMainWindowTitle`.
 */
export const APP_WINDOW_TITLE = "PwrAgent";

/**
 * Title for a shell window. Remote (federated) windows append the peer
 * label so windows targeting different machines stay tellable apart in
 * the Window menu; the local window is just the product name.
 */
export function mainWindowTitle(federationLabel?: string): string {
  const label = federationLabel?.trim();

  return label ? `${APP_WINDOW_TITLE} - ${label}` : APP_WINDOW_TITLE;
}

/**
 * Pin a shell window's OS title to `title`, ignoring whatever the
 * renderer's document title says.
 *
 * Electron mirrors the loaded page's `<title>` onto the native window
 * title by default, so the renderer's static `<title>` clobbered the
 * title passed at construction the moment the page finished loading.
 * That's what made every local window read `PwrAgnt` (the old spelling
 * baked into `index.html`) instead of the main-process value, and it is
 * why remote windows needed their own opt-out to keep the peer label.
 * Locking it here makes the main process the single owner for every
 * shell window, local and remote alike.
 *
 * This is the BrowserWindow event, not the webContents one — only the
 * window-level `preventDefault()` stops the title swap. The `setTitle`
 * re-assert is belt-and-suspenders for any path that slips past it.
 *
 * Auxiliary windows (Logs, Changelog, License, Activity, ...) share this
 * renderer entry point but set their own document titles on purpose;
 * they go through `registerAuxiliaryWindowTitle` instead.
 */
export function lockMainWindowTitle(
  window: BrowserWindow,
  title: string,
): void {
  window.setTitle(title);
  window.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(title);
  });
}
