/**
 * Hand a URL to the OS browser.
 *
 * The renderer's one way out to an external page. `window.open` with
 * `noopener,noreferrer` is what `applyWindowSecurityHardening`'s
 * `setWindowOpenHandler` turns into `shell.openExternal` plus a `deny`, so
 * nothing remote ever lands inside a BrowserWindow carrying this app's
 * preload.
 *
 * It lives here rather than beside its first caller because it has no
 * feature in it: the context rail's PR chips, the update surfaces' release
 * notes, and anything added next all want the same three arguments, and a
 * second copy is how one of them quietly loses `noreferrer`.
 */
export function openExternalUrl(url: string): void {
  if (typeof window === "undefined") {
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
