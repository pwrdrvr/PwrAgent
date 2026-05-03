import { ipcMain } from "electron";
import { PRELOAD_LOG_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

type PreloadLogLevel = "error" | "info" | "warn";

type PreloadLogRequest = {
  details?: unknown;
  level?: PreloadLogLevel;
  message?: string;
};

const preloadLog = getMainLogger("pwragent:preload");

export function registerPreloadLogIpcHandlers(): void {
  ipcMain.removeAllListeners(PRELOAD_LOG_CHANNEL);
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
}

export function disposePreloadLogIpcHandlers(): void {
  ipcMain.removeAllListeners(PRELOAD_LOG_CHANNEL);
}
