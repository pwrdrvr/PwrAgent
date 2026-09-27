export const STORAGE_MAINTENANCE_CHANNEL = "storage-maintenance:command";
export const STORAGE_MAINTENANCE_EVENT = "storage-maintenance:status";
export type StorageMaintenanceStatus = {
  phase: "ready" | "discovering" | "cleanup" | "vacuum" | "complete" | "cancelled" | "deferred" | "error";
  historyEnabled: boolean | null;
  beforeBytes: number;
  afterBytes?: number;
  completedThreads: number;
  eligibleThreads: number;
  message?: string;
};
export type StorageMaintenanceCommand =
  | { action: "status" | "hold" | "cancel" | "dismiss" }
  | { action: "start" | "preference"; historyEnabled: boolean };
