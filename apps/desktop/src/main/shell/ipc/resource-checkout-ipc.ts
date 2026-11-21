import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { RESOURCE_CHECKOUTS_CHANGED_CHANNEL, RESOURCE_CHECKOUTS_PERFORM_CHANNEL, RESOURCE_CHECKOUTS_READ_CHANNEL } from "../../../shared/ipc";
import type { DesktopResourceCheckoutService } from "../../resource-checkouts/resource-checkout-service";
import { subscribersForChannel } from "../window-channels";

function checkLocalWindow(event: IpcMainInvokeEvent): void {
  if (!subscribersForChannel(RESOURCE_CHECKOUTS_CHANGED_CHANNEL).includes(event.sender)
    || !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Resource checkouts are available to the local main window.");
  }
}

let unsubscribe: (() => void) | undefined;

export function registerResourceCheckoutIpcHandlers(service?: DesktopResourceCheckoutService): void {
  unsubscribe?.();
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_READ_CHANNEL);
  ipcMain.removeHandler(RESOURCE_CHECKOUTS_PERFORM_CHANNEL);
  if (!service) return;
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
