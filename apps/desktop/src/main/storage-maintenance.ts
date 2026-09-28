import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import { join } from "node:path";
import type { StateDb } from "./state/state-db";
import { findLiveProfileRuntimeMarkers, resolveActiveProfileName, resolveActiveProfilePath } from "./profile";
import { readStorageMaintenance, setStorageHistoryPreference, storageHistoryPolicy, storageMaintenanceDue, storageProcessAlive, writeStorageMaintenance, type StorageThreadIdentity } from "./state/storage-maintenance";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand, type StorageMaintenanceStatus } from "../shared/storage-maintenance";
import { readBootstrapAppearance, themedWindowAdditionalArguments } from "./settings/appearance-bootstrap";
import { themedWindowBackgroundColor } from "./native-appearance";

let interruptMaintenance: (() => Promise<void>) | undefined;
export async function interruptStartupStorageMaintenance(): Promise<void> {
  await interruptMaintenance?.();
}

/** Await only the job, not dismissal: a hovered result window survives startup. */
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
  const appearance = readBootstrapAppearance();
  const window = new BrowserWindow({
    width: 540, height: 460, title: "PwrAgent storage", show: false, resizable: false,
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
  let held = false;
  let running = false;
  let stopping = false;
  let finished = false;
  let worker: Electron.UtilityProcess | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
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
    release();
    if (!held && !window.isDestroyed()) closeTimer = setTimeout(() => { if (!held && !window.isDestroyed()) window.close(); }, 4000);
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
    if (command.action === "hold") { held = true; window.setAlwaysOnTop(true); if (closeTimer) clearTimeout(closeTimer); }
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
    if (closeTimer) clearTimeout(closeTimer);
    ipcMain.removeHandler(STORAGE_MAINTENANCE_CHANNEL);
    cancel();
  });
  try {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/storage-maintenance.html`);
    else await window.loadFile(join(__dirname, "../renderer/storage-maintenance.html"));
    window.show();
    if (policy.automatic) void start();
    await done;
  } catch {
    cancel();
    if (!window.isDestroyed()) window.close();
    await done;
  }
}
