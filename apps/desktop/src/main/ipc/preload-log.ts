import { ipcMain } from "electron";
import {
  PRELOAD_LOG_CHANNEL,
  STARTUP_PROFILE_EVENT_CHANNEL,
} from "../../shared/ipc";
import { getMainLogger } from "../log";
import {
  recordStartupProfileEvent,
  type StartupProfileEventSource,
} from "../diagnostics/startup-profile-events";

type PreloadLogLevel = "error" | "info" | "warn";

type PreloadLogRequest = {
  details?: unknown;
  level?: PreloadLogLevel;
  message?: string;
};

type StartupProfileRendererEventRequest = {
  detail?: Record<string, unknown>;
  source?: StartupProfileEventSource;
  type?: string;
};

const preloadLog = getMainLogger("pwragent:preload");

export function registerPreloadLogIpcHandlers(): void {
  ipcMain.removeAllListeners(PRELOAD_LOG_CHANNEL);
  ipcMain.removeAllListeners(STARTUP_PROFILE_EVENT_CHANNEL);
  ipcMain.on(
    PRELOAD_LOG_CHANNEL,
    (_event, request: PreloadLogRequest): void => {
      const level = request.level ?? "info";
      const message = request.message ?? "message";
      const details = request.details;

      if (details === undefined) {
        preloadLog[level](message);
        return;
      }

      preloadLog[level](message, details);
    },
  );
  ipcMain.on(
    STARTUP_PROFILE_EVENT_CHANNEL,
    (_event, request: StartupProfileRendererEventRequest): void => {
      const type = request.type?.trim();
      if (!type) {
        return;
      }

      recordStartupProfileEvent({
        source: request.source ?? "renderer",
        type,
        detail: request.detail,
      });
    },
  );
}

export function disposePreloadLogIpcHandlers(): void {
  ipcMain.removeAllListeners(PRELOAD_LOG_CHANNEL);
  ipcMain.removeAllListeners(STARTUP_PROFILE_EVENT_CHANNEL);
}
