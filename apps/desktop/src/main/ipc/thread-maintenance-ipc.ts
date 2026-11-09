import { ipcMain } from "electron";
import {
  THREAD_MAINTENANCE_SCAN_STEPS,
  type ThreadMaintenanceApplyRequest,
  type ThreadMaintenanceRules,
  type ThreadMaintenanceRun,
  type ThreadMaintenanceScan,
  type ThreadMaintenanceScanStep,
} from "@pwragent/shared";
import {
  APP_SERVER_APPLY_THREAD_MAINTENANCE_CHANNEL,
  APP_SERVER_GET_THREAD_MAINTENANCE_RUN_CHANNEL,
  APP_SERVER_SCAN_THREAD_MAINTENANCE_CHANNEL,
  APP_SERVER_STOP_THREAD_MAINTENANCE_CHANNEL,
  THREAD_MAINTENANCE_RUN_CHANGED_EVENT_CHANNEL,
  THREAD_MAINTENANCE_SCAN_PROGRESS_EVENT_CHANNEL,
} from "../../shared/ipc";
import { getThreadMaintenanceService, onThreadMaintenanceRun } from "../thread-maintenance-runtime";
import { createScanProgressSender } from "../thread-maintenance-scan-progress";
import { subscribersForChannel } from "../window-channels";
import { isFederationWindowWebContents } from "../window";

let unsubscribeRun: (() => void) | undefined;

type ScanRequest = {
  rules?: Partial<ThreadMaintenanceRules>;
  projectKey?: string;
  steps?: ThreadMaintenanceScanStep[];
  hibernateIdleDays?: number;
};

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
    async (event, request?: unknown): Promise<ThreadMaintenanceScan> => {
      local(event);
      const progressId = readProgressId(request);
      const reporter = progressId
        ? createScanProgressSender(event.sender, THREAD_MAINTENANCE_SCAN_PROGRESS_EVENT_CHANNEL, progressId)
        : undefined;
      try {
        return await getThreadMaintenanceService().scan(readScanRequest(request),
          reporter ? { onProgress: reporter.report } : {});
      } finally {
        reporter?.close();
      }
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

function readProgressId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).progressId;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : undefined;
}

function readScanRequest(value: unknown): ScanRequest {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const rules = record.rules && typeof record.rules === "object" ? record.rules as Record<string, unknown> : undefined;
  const steps = Array.isArray(record.steps)
    ? THREAD_MAINTENANCE_SCAN_STEPS.filter((step) => (record.steps as unknown[]).includes(step))
    : undefined;
  return {
    ...(typeof record.projectKey === "string" && record.projectKey ? { projectKey: record.projectKey } : {}),
    // An empty list asks for no step, never for every step.
    ...(steps ? { steps } : {}),
    ...(typeof record.hibernateIdleDays === "number" && Number.isInteger(record.hibernateIdleDays)
      && record.hibernateIdleDays >= 1 && record.hibernateIdleDays <= 3650
      ? { hibernateIdleDays: record.hibernateIdleDays } : {}),
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
    ...(list("removeBuildOutputs").length ? { removeBuildOutputs: list("removeBuildOutputs")
      .filter((item) => typeof item?.outputPath === "string")
      .map((item) => ({ outputPath: item.outputPath as string })) } : {}),
    hibernate: list("hibernate").filter((item) => typeof item.backend === "string" && typeof item.threadId === "string")
      .map((item) => ({ backend: item.backend as string, threadId: item.threadId as string })),
  };
}
