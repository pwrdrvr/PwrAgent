import { BrowserWindow } from "electron";
import { WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL } from "../shared/ipc";
import { subscribersForChannel } from "./window-channels";
import { isFederationWindowWebContents } from "./window";

/** What the dialog opens on. Both fields are optional. */
export type OpenThreadMaintenanceRequest = {
  /** Limit the first scan to one project (a project context menu). */
  projectKey?: string;
};

/**
 * Main → renderer push: open the Thread maintenance dialog in the focused
 * main window, else the first one. The dialog works on this machine only,
 * so remote federation windows never receive it.
 */
export function requestOpenThreadMaintenance(request: OpenThreadMaintenanceRequest = {}): boolean {
  const focused = BrowserWindow.getFocusedWindow();
  const subscribers = subscribersForChannel(WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL)
    .filter((subscriber) => !isFederationWindowWebContents(subscriber));
  const target = (focused && !focused.isDestroyed()
    ? subscribers.find((subscriber) => subscriber === focused.webContents)
    : undefined) ?? subscribers[0];
  if (!target) return false;
  const window = BrowserWindow.fromWebContents(target);
  if (window && !window.isDestroyed()) window.show();
  target.send(WINDOW_OPEN_THREAD_MAINTENANCE_CHANNEL, request);
  return true;
}
