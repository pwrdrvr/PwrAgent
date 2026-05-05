import { BrowserWindow, ipcMain } from "electron";
import type {
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
} from "@pwragent/shared";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import {
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
} from "../../shared/ipc";

let unsubscribePlatformStatus: (() => void) | undefined;

function broadcastPlatformStatusEvent(event: MessagingPlatformStatusEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      continue;
    }
    if (typeof window.webContents.send !== "function") {
      continue;
    }
    window.webContents.send(MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL, event);
  }
}

export function registerMessagingStatusIpcHandlers(): void {
  const runtime = getDesktopMessagingRuntime();

  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = runtime.onPlatformStatus(
    broadcastPlatformStatusEvent,
  );

  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.handle(
    MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
    async (): Promise<MessagingPlatformStatus[]> => {
      return runtime.getPlatformStatuses();
    },
  );
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
}
