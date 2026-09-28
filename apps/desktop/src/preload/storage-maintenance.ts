import { contextBridge, ipcRenderer } from "electron";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand, type StorageMaintenanceStatus } from "../shared/storage-maintenance";

let theme: "dark" | "light" | "system" = "system";
try {
  const argument = process.argv.find((value) => value.startsWith("--pwragent-appearance="));
  const value = argument ? JSON.parse(argument.slice("--pwragent-appearance=".length)) as { theme?: unknown } : undefined;
  if (value?.theme === "dark" || value?.theme === "light") theme = value.theme;
} catch { /* Use the system theme if the startup hint is unavailable. */ }
contextBridge.exposeInMainWorld("storageMaintenance", {
  theme,
  command: (command: StorageMaintenanceCommand): Promise<StorageMaintenanceStatus> => ipcRenderer.invoke(STORAGE_MAINTENANCE_CHANNEL, command),
  subscribe: (listener: (status: StorageMaintenanceStatus) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, status: StorageMaintenanceStatus) => listener(status);
    ipcRenderer.on(STORAGE_MAINTENANCE_EVENT, receive);
    return () => ipcRenderer.removeListener(STORAGE_MAINTENANCE_EVENT, receive);
  },
});
