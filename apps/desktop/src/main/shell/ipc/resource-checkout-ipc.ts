import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { isAppServerBackendKind } from "@pwragent/shared/contracts/navigation";
import type { ResourceThreadRef } from "@pwragent/shared/contracts/resource-checkouts";
import { RESOURCE_CHECKOUTS_CHANGED_CHANNEL, RESOURCE_CHECKOUTS_OPEN_THREAD_CHANNEL, RESOURCE_CHECKOUTS_PERFORM_CHANNEL, RESOURCE_CHECKOUTS_READ_CHANNEL, RESOURCE_CHECKOUTS_WINDOW_OPEN_CHANNEL } from "../../../shared/ipc";
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
  ipcMain.handle(RESOURCE_CHECKOUTS_WINDOW_OPEN_CHANNEL, (event) => {
    checkLocalWindow(event);
    if (!isLocalMainWindowWebContents(event.sender)) throw new Error("Open Resources from the local main window.");
    showResourcesWindow({ sourceWindow: BrowserWindow.fromWebContents(event.sender) ?? undefined });
  });
  ipcMain.handle(RESOURCE_CHECKOUTS_OPEN_THREAD_CHANNEL, (event, thread?: ResourceThreadRef) => {
    checkLocalWindow(event);
    if (!thread || typeof thread.backend !== "string" || !isAppServerBackendKind(thread.backend)
      || typeof thread.threadId !== "string" || !thread.threadId.trim()
      || (thread.instanceId !== undefined && typeof thread.instanceId !== "string")) return;
    requestShowThreadInPrimaryMainWindow({
      backend: thread.backend,
      threadId: thread.threadId,
      ...(thread.instanceId && thread.instanceId !== service.handoffInstanceId()
        ? { federationTarget: { scope: "remote", instanceId: thread.instanceId } } : {}),
    });
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
