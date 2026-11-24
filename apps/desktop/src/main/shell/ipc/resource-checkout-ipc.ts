import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { readResourceCheckoutsWindowFocus } from "@pwragent/shared/contracts/resource-checkouts";
import { RESOURCE_CHECKOUTS_CHANGED_CHANNEL, RESOURCE_CHECKOUTS_OPEN_THREAD_CHANNEL, RESOURCE_CHECKOUTS_PERFORM_CHANNEL, RESOURCE_CHECKOUTS_READ_CHANNEL, RESOURCE_CHECKOUTS_WINDOW_OPEN_CHANNEL } from "../../../shared/ipc";
import { resourceThreadShowRequest } from "../../resource-checkouts/checkout-projection";
import type { DesktopResourceCheckoutService } from "../../resource-checkouts/resource-checkout-service";
import { requestShowThreadInPrimaryMainWindow } from "../primary-main-window";
import { showResourcesWindow } from "../resources-window";
import { isLocalMainWindowWebContents, isLocalResourceCheckoutWebContents, subscribersForChannel } from "../window-channels";

function checkLocalWindow(event: IpcMainInvokeEvent): void {
  if (!isLocalResourceCheckoutWebContents(event.sender)
    || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Resource checkouts are available to local checkout windows.");
  }
}

let unsubscribe: (() => void) | undefined;

export function registerResourceCheckoutIpcHandlers(service?: DesktopResourceCheckoutService): void {
  unsubscribe?.();
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_READ_CHANNEL);
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_PERFORM_CHANNEL);
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_WINDOW_OPEN_CHANNEL);
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_OPEN_THREAD_CHANNEL);
  if (!service) return;
  ipcMain.handle(RESOURCE_CHECKOUTS_WINDOW_OPEN_CHANNEL, (event, focus?: unknown) => {
    checkLocalWindow(event);
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open Resources from the local main window.");
    showResourcesWindow(
      { sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined },
      readResourceCheckoutsWindowFocus(focus),
    );
  });
  ipcMain.handle(RESOURCE_CHECKOUTS_OPEN_THREAD_CHANNEL, (event, thread?: unknown) => {
    checkLocalWindow(event);
    requestShowThreadInPrimaryMainWindow(resourceThreadShowRequest(thread, service.handoffInstanceId()));
  });
  ipcMain.handle(RESOURCE_CHECKOUTS_READ_CHANNEL, (event) => {
    checkLocalWindow(event);
    return service.read();
  });
  ipcMain.handle(RESOURCE_CHECKOUTS_PERFORM_CHANNEL, (event, action: unknown) => {
    checkLocalWindow(event);
    return service.perform(action);
  });
  unsubscribe = service.subscribe((revision) => {
    for (const target of subscribersForChannel(RESOURCE_CHECKOUTS_CHANGED_CHANNEL)) {
      if (!target.isDestroyed()) target.send(RESOURCE_CHECKOUTS_CHANGED_CHANNEL, { revision });
    }
  });
}
