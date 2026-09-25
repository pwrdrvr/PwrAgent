import { existsSync } from "node:fs";
import { join } from "node:path";
import { ipcMain, nativeImage, type IpcMainEvent } from "electron";
import { SETTINGS_START_APP_ICON_DRAG_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

const appIconDragLog = getMainLogger("pwragent:app-icon-drag");

/**
 * PwrAgent's full-bleed 512px master (`build/icon.png`), which packaging ships
 * as `pwragent-app-icon.png`. The macOS `.icns` and `icon-macos.png` are padded
 * to Apple's safe area and are not the mark to hand another app. Slack's app
 * icon wants a square of 512 to 2000px, which this is.
 */
export function resolvePwragentAppIconPath(
  resourcesPath: string | undefined = process.resourcesPath,
): string | undefined {
  const candidates = [
    // `process.resourcesPath` exists only under Electron, and `join` throws on
    // undefined.
    ...(typeof resourcesPath === "string"
      ? [join(resourcesPath, "pwragent-app-icon.png")]
      : []),
    join(__dirname, "../../build/icon.png"),
    join(__dirname, "../../../build/icon.png"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * The renderer cannot put a file on the OS drag pasteboard; `startDrag` from
 * the sender's own `dragstart` can, which is what lets the icon be dropped
 * into a browser's upload field or file picker.
 */
function startAppIconDrag(event: IpcMainEvent): void {
  const file = resolvePwragentAppIconPath();
  if (!file) {
    appIconDragLog.warn("PwrAgent app icon file not found; drag ignored");
    return;
  }
  // The drag image must be non-empty on macOS.
  const icon = nativeImage.createFromPath(file).resize({ width: 64, height: 64 });
  event.sender.startDrag({ file, icon });
}

export function registerAppIconDragIpcHandlers(): void {
  ipcMain.removeAllListeners(SETTINGS_START_APP_ICON_DRAG_CHANNEL);
  ipcMain.on(SETTINGS_START_APP_ICON_DRAG_CHANNEL, startAppIconDrag);
}

export function disposeAppIconDragIpcHandlers(): void {
  ipcMain.removeAllListeners(SETTINGS_START_APP_ICON_DRAG_CHANNEL);
}
