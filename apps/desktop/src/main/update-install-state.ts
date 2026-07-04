/**
 * One-way latch that records when the app has handed control to the auto
 * updater's `quitAndInstall()` flow.
 *
 * On macOS, `autoUpdater.quitAndInstall()` (electron-updater's MacUpdater →
 * Electron's native Squirrel.Mac updater) closes every window first and only
 * then calls `app.quit()` itself, once the ShipIt relaunch has been armed.
 * Any code that reacts to `window-all-closed` (or `before-quit`) by calling
 * `app.quit()` on its own races that native teardown: the process can exit
 * before ShipIt finishes swapping the bundle, so the app relaunches into the
 * OLD version — or fails to relaunch at all. See the update-install quit path
 * in `auto-updater.ts` and the `window-all-closed` handler in `index.ts`.
 *
 * Once the install is underway there is no valid path back to a running app, so
 * this latch is intentionally never reset: the process is on its way down and
 * the updater owns the quit + relaunch.
 */
let updateInstallInProgress = false;

export function markUpdateInstallInProgress(): void {
  updateInstallInProgress = true;
}

export function isUpdateInstallInProgress(): boolean {
  return updateInstallInProgress;
}
