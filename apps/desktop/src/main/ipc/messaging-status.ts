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
import { getDesktopMessagingActivityLog } from "../messaging/desktop-messaging-activity-log";
import { getMainLogger } from "../log";
import { showMessagingActivityWindow } from "../messaging-activity-window";
import {
  MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL,
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_LIST_ACTIVITY_CHANNEL,
  MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_UNBIND_THREAD_CHANNEL,
} from "../../shared/ipc";

const log = getMainLogger("pwragent:messaging-ipc");

let unsubscribePlatformStatus: (() => void) | undefined;
let unsubscribeBindingsChanged: (() => void) | undefined;

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

function broadcastBindingsChanged(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (typeof window.isDestroyed === "function" && window.isDestroyed()) {
      continue;
    }
    if (typeof window.webContents.send !== "function") {
      continue;
    }
    window.webContents.send(MESSAGING_BINDINGS_CHANGED_EVENT_CHANNEL, {
      at: Date.now(),
    });
  }
}

export function registerMessagingStatusIpcHandlers(): void {
  const runtime = getDesktopMessagingRuntime();

  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = runtime.onPlatformStatus(
    broadcastPlatformStatusEvent,
  );
  unsubscribeBindingsChanged?.();
  unsubscribeBindingsChanged = runtime.onBindingsChanged(broadcastBindingsChanged);

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
      // Emit on the runtime bus rather than touching the store
      // directly. The runtime fans out to whichever controller owns
      // the binding's channel, which delivers the platform-side
      // retirement + "Thread detached" confirmation. This keeps the
      // IPC layer free of any per-platform knowledge — adding
      // Slack / Mattermost requires zero changes here.
      const result = await runtime.requestBindingRevoke({
        bindingId: request.bindingId,
        origin: "ui",
      });
      log.info("messaging binding unbound", {
        bindingId: request.bindingId,
        revoked: result.revoked,
        notifiedPlatform: result.notifiedPlatform,
      });
      return { revoked: result.revoked, bindingId: request.bindingId };
    },
  );

  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
  ipcMain.handle(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL, async (): Promise<void> => {
    showMessagingActivityWindow();
  });
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  unsubscribeBindingsChanged?.();
  unsubscribeBindingsChanged = undefined;
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.removeHandler(MESSAGING_LIST_ACTIVITY_CHANNEL);
  ipcMain.removeHandler(MESSAGING_UNBIND_THREAD_CHANNEL);
  ipcMain.removeHandler(MESSAGING_OPEN_ACTIVITY_WINDOW_CHANNEL);
}
