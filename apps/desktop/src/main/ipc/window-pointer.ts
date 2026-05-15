import { BrowserWindow, ipcMain, screen } from "electron";
import { WINDOW_POINTER_SNAPSHOT_CHANNEL } from "../../shared/ipc";
import type { WindowPointerSnapshot } from "../../shared/window-pointer";

export function registerWindowPointerIpcHandlers(): void {
  ipcMain.removeHandler(WINDOW_POINTER_SNAPSHOT_CHANNEL);
  ipcMain.handle(
    WINDOW_POINTER_SNAPSHOT_CHANNEL,
    async (event): Promise<WindowPointerSnapshot> => {
      const window = BrowserWindow.fromWebContents(event.sender);
      const contentBounds =
        window?.getContentBounds() ?? {
          height: 0,
          width: 0,
          x: 0,
          y: 0,
        };

      return {
        contentBounds,
        cursor: screen.getCursorScreenPoint(),
        windowFocused: Boolean(window?.isFocused()),
      };
    },
  );
}

export function disposeWindowPointerIpcHandlers(): void {
  ipcMain.removeHandler(WINDOW_POINTER_SNAPSHOT_CHANNEL);
}
