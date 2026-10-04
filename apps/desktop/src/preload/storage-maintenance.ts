import { contextBridge, ipcRenderer } from "electron";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand, type StorageMaintenanceStatus } from "../shared/storage-maintenance";

// The scheme alone is not the theme: the color theme (Light Blue, Solarized,
// ...) recolors the tokens on top of it, as index.html applies for the shell.
// Main already resolved these from config. Do not import `@pwragent/shared`
// to re-validate them: code shared with preload/index.ts is split into a
// sibling chunk, and a sandboxed preload cannot require one, which breaks the
// main window's preload too. A well-formed unknown id is inert in CSS.
const colorThemeId = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9-]*$/.test(value) ? value : undefined;
let theme: "dark" | "light" | "system" = "system";
let darkTheme: string | undefined;
let lightTheme: string | undefined;
try {
  const argument = process.argv.find((value) => value.startsWith("--pwragent-appearance="));
  const value = argument ? JSON.parse(argument.slice("--pwragent-appearance=".length)) as { theme?: unknown; darkTheme?: unknown; lightTheme?: unknown } : undefined;
  if (value?.theme === "dark" || value?.theme === "light") theme = value.theme;
  darkTheme = colorThemeId(value?.darkTheme);
  lightTheme = colorThemeId(value?.lightTheme);
} catch { /* Use the system theme if the startup hint is unavailable. */ }
contextBridge.exposeInMainWorld("storageMaintenance", {
  theme, darkTheme, lightTheme,
  platform: process.platform,
  command: (command: StorageMaintenanceCommand): Promise<StorageMaintenanceStatus> => ipcRenderer.invoke(STORAGE_MAINTENANCE_CHANNEL, command),
  subscribe: (listener: (status: StorageMaintenanceStatus) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, status: StorageMaintenanceStatus) => listener(status);
    ipcRenderer.on(STORAGE_MAINTENANCE_EVENT, receive);
    return () => ipcRenderer.removeListener(STORAGE_MAINTENANCE_EVENT, receive);
  },
});
