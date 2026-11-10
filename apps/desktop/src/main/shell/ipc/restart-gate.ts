import { ipcMain } from "electron";
import {
  RESTART_GATE_RELEASE_CHANNEL,
  RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL,
  RESTART_GATE_STATUS_CHANNEL,
} from "../../../shared/ipc";
import type { RestartGateStatus } from "../../../shared/restart-gate";
import { getDesktopBackendRegistry } from "../../app-server/backend-registry";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";

let unsubscribeRestartGateStatus: (() => void) | undefined;

/**
 * The quiet-restart gate for the main window's notice. It is this machine's
 * own state, so a peer's window neither hears it nor opens it.
 */
export function registerRestartGateIpcHandlers(): void {
  const registry = getDesktopBackendRegistry();
  unsubscribeRestartGateStatus?.();
  unsubscribeRestartGateStatus = registry.onRestartGateStatusChanged((status) => {
    for (const webContents of subscribersForChannel(RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL)) {
      if (!webContents.isDestroyed()) {
        webContents.send(RESTART_GATE_STATUS_CHANGED_EVENT_CHANNEL, status);
      }
    }
  });

  ipcMain.removeHandler(RESTART_GATE_STATUS_CHANNEL);
  ipcMain.handle(RESTART_GATE_STATUS_CHANNEL, (event): RestartGateStatus =>
    isFederationWindowWebContents(event?.sender)
      ? { phase: "open" }
      : getDesktopBackendRegistry().getRestartGateStatus());

  ipcMain.removeHandler(RESTART_GATE_RELEASE_CHANNEL);
  ipcMain.handle(RESTART_GATE_RELEASE_CHANNEL, (event): RestartGateStatus => {
    if (isFederationWindowWebContents(event?.sender)) {
      throw new Error("A peer's window cannot release this instance's restart gate.");
    }
    return getDesktopBackendRegistry().releaseRestartGate();
  });
}

export function disposeRestartGateIpcHandlers(): void {
  unsubscribeRestartGateStatus?.();
  unsubscribeRestartGateStatus = undefined;
  ipcMain.removeHandler(RESTART_GATE_STATUS_CHANNEL);
  ipcMain.removeHandler(RESTART_GATE_RELEASE_CHANNEL);
}
