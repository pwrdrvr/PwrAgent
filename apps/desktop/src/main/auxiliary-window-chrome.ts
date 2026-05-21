import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from "electron";
import { app } from "electron";

const supportsPerWindowMenuBar =
  process.platform === "linux" || process.platform === "win32";

const hiddenMenuBarWindows = new Set<BrowserWindow>();

export function auxiliaryWindowChromeOptions(): Pick<
  BrowserWindowConstructorOptions,
  "autoHideMenuBar" | "titleBarStyle" | "trafficLightPosition"
> {
  if (process.platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 20, y: 18 },
    };
  }

  return {
    autoHideMenuBar: true,
  };
}

export function hideAuxiliaryWindowMenuBar(window: BrowserWindow): void {
  if (!supportsPerWindowMenuBar) return;

  hiddenMenuBarWindows.add(window);
  window.setAutoHideMenuBar(true);
  window.setMenuBarVisibility(false);
  window.once("closed", () => {
    hiddenMenuBarWindows.delete(window);
  });
}

export function showAndFocusAuxiliaryWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  window.focus();
  app.focus({ steal: true });
}

export function reapplyAuxiliaryWindowMenuBars(): void {
  if (!supportsPerWindowMenuBar) return;

  for (const window of hiddenMenuBarWindows) {
    if (window.isDestroyed()) {
      hiddenMenuBarWindows.delete(window);
      continue;
    }
    window.setAutoHideMenuBar(true);
    window.setMenuBarVisibility(false);
  }
}
