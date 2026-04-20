import { ipcMain } from "electron";
import type { RendererErrorReport } from "../../shared/renderer-error";
import { RENDERER_ERROR_REPORT_CHANNEL } from "../../shared/ipc";
import { getMainLogger } from "../log";

const rendererErrorLog = getMainLogger("pwragnt:renderer:error");

export function registerRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
  ipcMain.handle(
    RENDERER_ERROR_REPORT_CHANNEL,
    async (_event, report: RendererErrorReport): Promise<{ ok: true }> => {
      rendererErrorLog.error("report", report);
      return { ok: true };
    },
  );
}

export function disposeRendererErrorIpcHandlers(): void {
  ipcMain.removeHandler(RENDERER_ERROR_REPORT_CHANNEL);
}

