import type { StorageMaintenanceStorage } from "@pwragent/owner-core/storage-maintenance-storage";
import { getAppStateDb } from "../state/app-state";
import {
  observeStorageArchive, readStorageMaintenance, setStorageHistoryPreference, writeStorageMaintenance,
} from "../state/storage-maintenance";

export { storageProcessAlive } from "../state/storage-maintenance";

/** Capture the startup database at the existing maintenance boundary. */
export function getDesktopStorageMaintenanceStorage(): StorageMaintenanceStorage {
  const db = getAppStateDb().raw;
  return {
    read: () => readStorageMaintenance(db),
    write: (record) => writeStorageMaintenance(db, record),
    setHistoryPreference: (enabled) => setStorageHistoryPreference(db, enabled),
    readBytes: () => (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number),
    listRunningProcessIds: () => {
      const instances = db.prepare("SELECT process_id FROM app_runtime_instances WHERE exited_at IS NULL").all() as Array<{ process_id: number }>;
      return instances.map(instance => instance.process_id);
    },
    observeArchive: (backend, threadId, archived, now) => observeStorageArchive(db, backend, threadId, archived, now),
  };
}

