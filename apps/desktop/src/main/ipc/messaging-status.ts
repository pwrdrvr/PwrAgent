import { BrowserWindow, ipcMain } from "electron";
import type {
  MessagingPlatformStatus,
  MessagingPlatformStatusEvent,
  SetMessagingEnabledRequest,
  SetMessagingEnabledResponse,
} from "@pwragent/shared";
import { getDesktopMessagingRuntime } from "../messaging/messaging-runtime";
import { resolveRuntimeMessagingOverride } from "../runtime-flags";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import {
  MESSAGING_GET_PLATFORM_STATUSES_CHANNEL,
  MESSAGING_PLATFORM_STATUS_EVENT_CHANNEL,
  MESSAGING_SET_ENABLED_CHANNEL,
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

  ipcMain.removeHandler(MESSAGING_SET_ENABLED_CHANNEL);
  ipcMain.handle(
    MESSAGING_SET_ENABLED_CHANNEL,
    async (
      _event,
      request: SetMessagingEnabledRequest,
    ): Promise<SetMessagingEnabledResponse> => {
      const override = resolveRuntimeMessagingOverride();
      if (override.disabled) {
        // Startup --disable-messaging / PWRAGENT_DISABLE_MESSAGING wins.
        // Don't touch the user setting; report the override so the UI
        // can render an explanatory tooltip on the locked toggle.
        return {
          enabled: false,
          overridden: true,
          overrideReason: override.reason,
        };
      }
      // Persist the user choice so the next launch respects it. We
      // write before pause/resume so a crash mid-toggle still leaves a
      // consistent on-disk truth.
      await getDesktopSettingsService().writeConfigPatch({
        messaging: { userEnabled: request.enabled },
      });
      if (request.enabled) {
        await runtime.resume();
      } else {
        await runtime.pause();
      }
      return { enabled: request.enabled, overridden: false };
    },
  );
}

export async function disposeMessagingStatusIpcHandlers(): Promise<void> {
  unsubscribePlatformStatus?.();
  unsubscribePlatformStatus = undefined;
  ipcMain.removeHandler(MESSAGING_GET_PLATFORM_STATUSES_CHANNEL);
  ipcMain.removeHandler(MESSAGING_SET_ENABLED_CHANNEL);
}
