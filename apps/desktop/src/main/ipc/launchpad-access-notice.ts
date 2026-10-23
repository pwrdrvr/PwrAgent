import { ipcMain } from "electron";
import {
  LAUNCHPAD_ACCESS_NOTICE_DISMISS_CHANNEL,
  LAUNCHPAD_ACCESS_NOTICE_READ_CHANNEL,
} from "../../shared/ipc";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";

/**
 * The one-time notice that upgraded launchpads now start Codex and Claude
 * threads on Auto. The state DB holds it pending until the operator closes it.
 */
export function registerLaunchpadAccessNoticeIpcHandlers(): void {
  ipcMain.removeHandler(LAUNCHPAD_ACCESS_NOTICE_READ_CHANNEL);
  ipcMain.handle(
    LAUNCHPAD_ACCESS_NOTICE_READ_CHANNEL,
    (): boolean => getDesktopOverlayStore().isLaunchpadAutoAccessNoticePending(),
  );
  ipcMain.removeHandler(LAUNCHPAD_ACCESS_NOTICE_DISMISS_CHANNEL);
  ipcMain.handle(LAUNCHPAD_ACCESS_NOTICE_DISMISS_CHANNEL, (): void => {
    getDesktopOverlayStore().dismissLaunchpadAutoAccessNotice();
  });
}

export function disposeLaunchpadAccessNoticeIpcHandlers(): void {
  ipcMain.removeHandler(LAUNCHPAD_ACCESS_NOTICE_READ_CHANNEL);
  ipcMain.removeHandler(LAUNCHPAD_ACCESS_NOTICE_DISMISS_CHANNEL);
}
