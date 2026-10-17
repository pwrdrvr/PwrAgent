import { ipcMain, shell } from "electron";
import type { ServiceUiRequest } from "@pwragent/shared";
import { FEDERATION_SERVICES_CHANNEL } from "../../shared/ipc";
import { getDesktopFederationRuntime } from "../federation/federation-runtime";

const watchedWindows = new Set<number>();

export function registerFederationServicesIpc(): void {
  ipcMain.removeHandler(FEDERATION_SERVICES_CHANNEL);
  ipcMain.handle(FEDERATION_SERVICES_CHANNEL, async (event, input: ServiceUiRequest) => {
    if (!input || typeof input.viewId !== "string" || !input.viewId || input.viewId.length > 128 || !["watch", "list", "connect", "disconnect", "open", "remove", "leave"].includes(input.action)
      || (input.instanceId !== undefined && (typeof input.instanceId !== "string" || input.instanceId.length > 256))) {
      throw new Error("Invalid service action.");
    }
    const runtime = getDesktopFederationRuntime();
    const windowId = event.sender.id;
    if (!watchedWindows.has(windowId)) {
      watchedWindows.add(windowId);
      event.sender.once("destroyed", () => {
        watchedWindows.delete(windowId);
        runtime.leaveThreadServices(windowId);
      });
      event.sender.on("render-process-gone", () => runtime.leaveThreadServices(windowId));
      event.sender.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) runtime.leaveThreadServices(windowId);
      });
    }
    const result = await runtime.threadServiceAction(windowId, input);
    if (event.sender.isDestroyed()) {
      runtime.leaveThreadServices(windowId);
      throw new Error("Service viewer closed.");
    }
    if (input.action === "open") {
      const forward = result.forwards.find((entry) => entry.forwardId === input.forwardId);
      if (!forward?.url || !/^https?:\/\/127\.0\.0\.1:[0-9]+\/$/.test(forward.url)) throw new Error("Connect an HTTP or HTTPS service before opening it.");
      await shell.openExternal(forward.url);
    }
    return result;
  });
}
