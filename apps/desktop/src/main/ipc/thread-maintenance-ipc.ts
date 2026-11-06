import { ipcMain } from "electron";
import type {
  ThreadMaintenanceApplyRequest,
  ThreadMaintenanceRules,
  ThreadMaintenanceRun,
  ThreadMaintenanceScan,
} from "@pwragent/shared";
import {
  APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL,
  APP_SERVER_GET_THREAD_MAINTENANCE_RUN_CHANNEL,
  APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL,
  APP_SERVER_STOP_THREAD_MAINTENANCE_CHANNEL,
  THREAD_MAINTENANCE_RUN_CHANGED_EVENT_CHANNEL,
} from "../../shared/ipc";
import { getThreadMaintenanceService, onThreadMaintenanceRun } from "../thread-maintenance-runtime";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";

let unsubscribeRun: (() => void) | undefined;

/** Thread maintenance works on this machine's threads only, so a remote
 * (federation) window is refused on every channel. */
export function registerThreadMaintenanceIpc(): void {
  unsubscribeRun?.();
  unsubscribeRun = onThreadMaintenanceRun((run) => {
    for (const webContents of subscribersForChannel(THREAD_MAINTENANCE_RUN_CHANGED_EVENT_CHANNEL)) {
      if (!webContents.isDestroyed()) webContents.send(THREAD_MAINTENANCE_RUN_CHANGED_EVENT_CHANNEL, run);
    }
  });
  const local = (event: Electron.IpcMainInvokeEvent | undefined) => {
    if (isFederationWindowWebContents(event?.sender)) {
      throw new Error("A remote window cannot run this machine's thread maintenance.");
    }
  };
  ipcMain.removeHandler(APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL);
  ipcMain.handle(APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL,
    async (event, request?: { rules?: Partial<ThreadMaintenanceRules>; projectKey?: string }): Promise<ThreadMaintenanceScan> => {
      local(event);
      return await getThreadMaintenanceService().scan(readScanRequest(request));
    });
  ipcMain.removeHandler(APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL);
  ipcMain.handle(APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL,
    (event, request: ThreadMaintenanceApplyRequest): ThreadMaintenanceRun => {
      local(event);
      // Resolve once the run starts; progress and the result arrive as events.
      const { run, done } = getThreadMaintenanceService().start(readApplyRequest(request));
      void done.catch(() => {});
      return run;
    });
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_MAINTENANCE_RUN_CHANNEL);
  ipcMain.handle(APP_SERVER_GET_THREAD_MAINTENANCE_RUN_CHANNEL, (event): ThreadMaintenanceRun | null => {
    local(event);
    return getThreadMaintenanceService().getRun() ?? null;
  });
  ipcMain.removeHandler(APP_SERVER_STOP_THREAD_MAINTENANCE_CHANNEL);
  ipcMain.handle(APP_SERVER_STOP_THREAD_MAINTENANCE_CHANNEL, (event): void => {
    local(event);
    getThreadMaintenanceService().stop();
  });
}

export function unregisterThreadMaintenanceIpc(): void {
  unsubscribeRun?.();
  unsubscribeRun = undefined;
  ipcMain.removeHandler(APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_GET_THREAD_MAINTENANCE_RUN_CHANNEL);
  ipcMain.removeHandler(APP_SERVER_STOP_THREAD_MAINTENANCE_CHANNEL);
}

function readScanRequest(value: unknown): { rules?: Partial<ThreadMaintenanceRules>; projectKey?: string } {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const rules = record.rules && typeof record.rules === "object" ? record.rules as Record<string, unknown> : undefined;
  return {
    ...(typeof record.projectKey === "string" && record.projectKey ? { projectKey: record.projectKey } : {}),
    ...(rules ? { rules: {
      ...(rules.mode === "count" || rules.mode === "age" ? { mode: rules.mode } : {}),
      ...(typeof rules.keepPerProject === "number" ? { keepPerProject: rules.keepPerProject } : {}),
      ...(typeof rules.inactivityDays === "number" ? { inactivityDays: rules.inactivityDays } : {}),
      ...(typeof rules.rebuildableOutputIsClean === "boolean" ? { rebuildableOutputIsClean: rules.rebuildableOutputIsClean } : {}),
    } } : {}),
  };
}

function readApplyRequest(value: unknown): ThreadMaintenanceApplyRequest {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof record.scanId !== "string") throw new Error("A scan id is required.");
  const list = (key: string) => Array.isArray(record[key]) ? record[key] as Record<string, unknown>[] : [];
  return {
    scanId: record.scanId,
    archive: list("archive").filter((item) => typeof item.backend === "string" && typeof item.threadId === "string")
      .map((item) => ({ backend: item.backend as string, threadId: item.threadId as string,
        ...(item.overLimit === "keepCheckout" || item.overLimit === "snapshotAll" ? { overLimit: item.overLimit } : {}) })),
    removeCheckouts: list("removeCheckouts")
      .filter((item) => typeof item.backend === "string" && typeof item.threadId === "string" && typeof item.worktreePath === "string")
      .map((item) => ({ backend: item.backend as string, threadId: item.threadId as string, worktreePath: item.worktreePath as string })),
    trashCheckouts: list("trashCheckouts").filter((item) => typeof item.worktreePath === "string")
      .map((item) => ({ worktreePath: item.worktreePath as string })),
    removeUnreferenced: list("removeUnreferenced").filter((item) => typeof item.worktreePath === "string")
      .map((item) => ({ worktreePath: item.worktreePath as string })),
    removeEmptyFolders: record.removeEmptyFolders === true,
    hibernate: list("hibernate").filter((item) => typeof item.backend === "string" && typeof item.threadId === "string")
      .map((item) => ({ backend: item.backend as string, threadId: item.threadId as string })),
  };
}
