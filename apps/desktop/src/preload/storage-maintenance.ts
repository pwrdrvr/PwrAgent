import { contextBridge, ipcRenderer } from "electron";
import { DESKTOP_DARK_THEME_DEFAULT, DESKTOP_LIGHT_THEME_DEFAULT, isDesktopDarkTheme, isDesktopLightTheme, type DesktopDarkTheme, type DesktopLightTheme } from "@pwragent/shared";
import { STORAGE_MAINTENANCE_CHANNEL, STORAGE_MAINTENANCE_EVENT, type StorageMaintenanceCommand, type StorageMaintenanceStatus } from "../shared/storage-maintenance";

// The scheme alone is not the theme: the color theme (Light Blue, Solarized,
// ...) recolors the tokens on top of it, as index.html applies for the shell.
let theme: "dark" | "light" | "system" = "system";
let darkTheme: DesktopDarkTheme = DESKTOP_DARK_THEME_DEFAULT;
let lightTheme: DesktopLightTheme = DESKTOP_LIGHT_THEME_DEFAULT;
try {
  const argument = process.argv.find((value) => value.startsWith("--pwragent-appearance="));
  const value = argument ? JSON.parse(argument.slice("--pwragent-appearance=".length)) as { theme?: unknown; darkTheme?: unknown; lightTheme?: unknown } : undefined;
  if (value?.theme === "dark" || value?.theme === "light") theme = value.theme;
  if (typeof value?.darkTheme === "string" && isDesktopDarkTheme(value.darkTheme)) darkTheme = value.darkTheme;
  if (typeof value?.lightTheme === "string" && isDesktopLightTheme(value.lightTheme)) lightTheme = value.lightTheme;
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
