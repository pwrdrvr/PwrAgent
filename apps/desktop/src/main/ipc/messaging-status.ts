import { BrowserWindow, ipcMain } from "electron";
import type {
  ListMessagingActivityRequest,
  ListMessagingActivityResponse,
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  UnbindMessagingThreadRequest,
  UnbindMessagingThreadResponse,
} from "@pwragent/shared";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { getDesktopMessagingStore } from "../messaging/desktop-messaging-store";
import { getDesktopMessagingActivityLog } from "../messaging/desktop-messaging-activity-log";
import { getMainLogger } from "../log";
import {
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
} from "../../shared/ipc";

const log = getMainLogger("pwragent:messaging-ipc");

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

  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.handle(
    MESSAGING_LIST_ACTIVITY_CHANNEL,
    async (
      _event,
      request: ListMessagingActivityRequest | undefined,
    ): Promise<ListMessagingActivityResponse> => {
      const entries = getDesktopMessagingActivityLog().list({
        limit: request?.limit,
        sinceId: request?.sinceId,
      });
      return { entries };
    },
  );

  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
  ipcMain.handle(
    MESSAGING_UNBIND_THREAD_CHANNEL,
    async (
      _event,
      request: UnbindMessagingThreadRequest,
    ): Promise<UnbindMessagingThreadResponse> => {
      const store = getDesktopMessagingStore();
      const revoked = await store.revokeBinding({ bindingId: request.bindingId });
      log.info("messaging binding unbound", {
        bindingId: request.bindingId,
        revoked: Boolean(revoked),
        platform: revoked?.channel?.channel ?? null,
        backend: revoked?.backend ?? null,
        threadId: revoked?.threadId ?? null,
      });
      return { revoked: Boolean(revoked), bindingId: request.bindingId };
    },
  );
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
}
