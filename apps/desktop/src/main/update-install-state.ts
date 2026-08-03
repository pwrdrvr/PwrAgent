/**
 * One-way latches for an accepted auto-update restart. The first blocks any
 * competing ordinary quit while bounded teardown runs; the second records the
 * immediate native `quitAndInstall()` handoff, when before-quit must no longer
 * be intercepted.
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
 * Once preparation is underway there is no valid path back to a running app,
 * so these latches are intentionally never reset.
 */
let updateInstallInProgress = false;
let updaterQuitReady = false;
let prepareUpdateInstall: (() => Promise<void>) | undefined;

export function setUpdateInstallPreparationHandler(
  handler: (() => Promise<void>) | undefined,
): void {
  prepareUpdateInstall = handler;
}

export async function prepareForUpdateInstall(): Promise<void> {
  await prepareUpdateInstall?.();
}

export function markUpdateInstallInProgress(): void {
  updateInstallInProgress = true;
}

export function markUpdateInstallUpdaterQuitReady(): void {
  updaterQuitReady = true;
}

export function isUpdateInstallInProgress(): boolean {
  return updateInstallInProgress;
}

export function isUpdateInstallUpdaterQuitReady(): boolean {
  return updaterQuitReady;
}
