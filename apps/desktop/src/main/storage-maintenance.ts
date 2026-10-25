import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { join } from "node:path";
import type { StateDb } from "./state/state-db";
import { findLiveProfileRuntimeMarkers, resolveActiveProfileName, resolveActiveProfilePath } from "./profile";
import { readStorageMaintenance, setStorageHistoryPreference, storageHistoryPolicy, storageMaintenanceDue, storageProcessAlive, writeStorageMaintenance, type StorageThreadIdentity } from "./state/storage-maintenance";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand, type StorageMaintenanceStatus } from "../shared/storage-maintenance";
import { readBootstrapAppearance, themedWindowAdditionalArguments } from "./settings/appearance-bootstrap";
import { themedWindowBackgroundColor } from "./native-appearance";
import { auxiliaryWindowChromeOptions } from "./auxiliary-window-chrome";
import { getMainLogger } from "./log";

const storageLog = getMainLogger("pwragent:storage-maintenance");

/**
 * Startup waits for this window before it creates the main window, and the
 * window stays hidden until its page loads. A page that never loads would
 * leave the app running with no window at all, so the wait is bounded.
 */
export const STORAGE_WINDOW_LOAD_TIMEOUT_MS = 15_000;

let interruptMaintenance: (() => Promise<void>) | undefined;
export async function interruptStartupStorageMaintenance(): Promise<void> {
  await interruptMaintenance?.();
}

/**
 * Await only the job, not dismissal: the result window outlives startup and
 * closes itself on the renderer's countdown, which pauses under the pointer.
 */
export async function runStartupStorageMaintenance(options: {
  state: StateDb;
  existingDatabase: boolean;
  onboardingCompleted: boolean;
  discover: () => Promise<{ archived: StorageThreadIdentity[]; active: StorageThreadIdentity[] }>;
}): Promise<void> {
  const db = options.state.raw;
  const record = readStorageMaintenance(db);
  const policy = storageHistoryPolicy(record);
  const bytes = (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
  if (!storageMaintenanceDue({ ...options, bytes, attemptedAt: record.attemptedAt, now: Date.now() })) return;
  const otherInstances = () => {
    if (findLiveProfileRuntimeMarkers(resolveActiveProfileName()).some((marker) => marker.processId !== process.pid)) return true;
    // An old or busy process can miss a file heartbeat; a live registered PID
    // still owns its profile. Prefer a conservative deferral over stealing it.
    const instances = db.prepare("SELECT process_id FROM app_runtime_instances WHERE exited_at IS NULL").all() as Array<{ process_id: number }>;
    return instances.some((instance) => instance.process_id !== process.pid && storageProcessAlive(instance.process_id));
  };
  if (otherInstances()) return;
  const startedAt = Date.now();
  storageLog.info("startup storage maintenance due", {
    bytes,
    automatic: policy.automatic,
    historyEnabled: policy.historyEnabled,
  });
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 540, height: 460, title: "PwrAgent storage", show: false,
    // The Pwr-family title strip, as every auxiliary window draws it; the
    // window is fixed-size, so there is nothing for the green button to zoom.
    ...auxiliaryWindowChromeOptions(), resizable: false, maximizable: false,
    backgroundColor: themedWindowBackgroundColor(appearance),
    webPreferences: {
      preload: join(__dirname, "../preload/storage-maintenance.cjs"),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
      additionalArguments: themedWindowAdditionalArguments(appearance),
    },
  });
  let status: StorageMaintenanceStatus = {
    phase: "ready", historyEnabled: policy.historyEnabled, beforeBytes: bytes,
    completedThreads: 0, eligibleThreads: 0,
  };
  let running = false;
  let stopping = false;
  let finished = false;
  let worker: Electron.UtilityProcess | undefined;
  let ownershipTimer: ReturnType<typeof setInterval> | undefined;
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => { release = resolve; });
  const publish = (patch: Partial<StorageMaintenanceStatus>) => {
    status = { ...status, ...patch };
    if (!window.isDestroyed()) window.webContents.send(STORAGE_MAINTENANCE_EVENT, status);
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    app.removeListener("before-quit", cancel);
    interruptMaintenance = undefined;
    if (ownershipTimer) clearInterval(ownershipTimer);
    storageLog.info("startup storage maintenance released startup", {
      phase: status.phase,
      durationMs: Date.now() - startedAt,
    });
    release();
  };
  const cancel = () => {
    if (finished) return;
    stopping = true;
    publish({ phase: "cancelled", message: "Stopped. Completed cleanup is kept; unfinished work can continue on a later startup." });
    if (worker) worker.kill();
    else {
      const latest = readStorageMaintenance(db);
      if (latest.attemptedAt === undefined || Date.now() - latest.attemptedAt >= 24 * 60 * 60 * 1000) {
        writeStorageMaintenance(db, { ...latest, attemptedAt: Date.now() });
      }
      finish();
    }
  };
  interruptMaintenance = async () => { cancel(); await done; };
  app.once("before-quit", cancel);
  const start = async () => {
    const { historyEnabled } = storageHistoryPolicy(readStorageMaintenance(db));
    if (running || finished) return;
    running = true;
    publish({ historyEnabled, phase: "discovering" });
    try {
      // No provider access is needed for ordinary expiry/compaction when the
      // operator declines history cleanup.
      const identities = historyEnabled ? await options.discover() : { archived: [], active: [] };
      if (finished || status.phase === "cancelled") return;
      if (otherInstances()) {
        publish({ phase: "deferred", message: "Another PwrAgent instance is using this profile. Storage optimization will wait." });
        finish(); return;
      }
      worker = utilityProcess.fork(join(__dirname, "storage-maintenance-worker.js"), [], { stdio: "ignore", serviceName: "PwrAgent storage maintenance" });
      ownershipTimer = setInterval(() => {
        if (worker && otherInstances()) {
          stopping = true;
          publish({ phase: "deferred", message: "Another instance opened this profile. Unfinished optimization will continue on a later startup." });
          worker.kill();
        }
      }, 250);
      worker.on("message", (next: Partial<StorageMaintenanceStatus>) => { if (!stopping) publish(next); });
      worker.once("exit", (code) => {
        if (!["complete", "cancelled", "deferred", "error"].includes(status.phase)) {
          publish({ phase: "error", message: code === 0 ? "Storage optimization finished." : "Storage optimization stopped. PwrAgent can still start; unfinished work will be retried later." });
        }
        worker = undefined;
        finish();
      });
      worker.postMessage({ dbPath: resolveActiveProfilePath("state/state.db"), historyEnabled, ...identities });
    } catch {
      if (worker) {
        stopping = true;
        publish({ phase: "error", message: "Storage optimization stopped. Unfinished work can continue on a later startup." });
        worker.kill();
        return;
      }
      const latest = readStorageMaintenance(db);
      if (latest.attemptedAt === undefined || Date.now() - latest.attemptedAt >= 24 * 60 * 60 * 1000) {
        writeStorageMaintenance(db, { ...latest, attemptedAt: Date.now() });
      }
      publish({ phase: "error", message: "Archived thread status could not be verified. Nothing was removed; PwrAgent will try again later." });
      finish();
    }
  };
  ipcMain.handle(STORAGE_MAINTENANCE_CHANNEL, async (event, command: StorageMaintenanceCommand) => {
    if (event.sender !== window.webContents) throw new Error("Invalid storage maintenance sender");
    if (command.action === "hold") window.setAlwaysOnTop(true);
    if (command.action === "cancel") cancel();
    if (command.action === "dismiss") window.close();
    if (command.action === "start") void start();
    if (command.action === "preference" && (status.phase === "ready" || finished) && typeof command.historyEnabled === "boolean") {
      setStorageHistoryPreference(db, command.historyEnabled);
      publish({ historyEnabled: command.historyEnabled });
    }
    return status;
  });
  window.once("closed", () => {
    ipcMain.removeHandler(STORAGE_MAINTENANCE_CHANNEL);
    cancel();
  });
  const load = process.env.ELECTRON_RENDERER_URL
    ? window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/storage-maintenance.html`)
    : window.loadFile(join(__dirname, "../renderer/storage-maintenance.html"));
  // Closing the window aborts the load; that rejection is expected and must
  // not reach the process-level unhandled-rejection handler.
  load.catch(() => {});
  let loadTimer: ReturnType<typeof setTimeout> | undefined;
  const loadTimedOut = new Promise<"timeout">((resolve) => {
    loadTimer = setTimeout(() => resolve("timeout"), STORAGE_WINDOW_LOAD_TIMEOUT_MS);
  });
  try {
    const loaded = await Promise.race([
      load.then(() => "loaded" as const),
      loadTimedOut,
      // A quit cancels the job while the page is still loading.
      done.then(() => "released" as const),
    ]);
    if (loaded === "released") {
      if (!window.isDestroyed()) window.close();
      return;
    }
    if (loaded === "timeout") {
      // Skip the job for this launch rather than keep the app windowless.
      // cancel() records the attempt, so the next try waits for the usual
      // interval instead of repeating this wait on every launch.
      storageLog.warn("startup storage maintenance window did not load; continuing startup without it", {
        timeoutMs: STORAGE_WINDOW_LOAD_TIMEOUT_MS,
        ...windowLoadState(window),
      });
      cancel();
      if (!window.isDestroyed()) window.close();
      await done;
      return;
    }
    window.show();
    if (policy.automatic) void start();
    await done;
  } catch (error) {
    if (!finished) {
      storageLog.warn("startup storage maintenance window failed to load", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    cancel();
    if (!window.isDestroyed()) window.close();
    await done;
  } finally {
    clearTimeout(loadTimer);
  }
}

function windowLoadState(window: BrowserWindow): Record<string, unknown> {
  if (window.isDestroyed()) return { destroyed: true };
  const contents = window.webContents;
  return {
    url: contents.getURL?.(),
    isLoading: contents.isLoading?.(),
    isWaitingForResponse: contents.isWaitingForResponse?.(),
    isCrashed: contents.isCrashed?.(),
    rendererPid: contents.getOSProcessId?.(),
  };
}
