import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from "electron";

const supportsPerWindowMenuBar =
  process.platform === "linux" || process.platform === "win32";
const supportsMoveTop = process.platform !== "linux";

const hiddenMenuBarWindows = new Set<BrowserWindow>();
const auxiliaryWindowTitles = new Map<number, string>();

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

export function registerAuxiliaryWindowTitle(
  window: BrowserWindow,
  title: string,
): void {
  auxiliaryWindowTitles.set(window.id, title);
  window.setTitle(title);
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(title);
  });
  window.once("closed", () => {
    auxiliaryWindowTitles.delete(window.id);
  });
}

export function getAuxiliaryWindowMenuTitle(window: BrowserWindow): string {
  return auxiliaryWindowTitles.get(window.id) ?? window.getTitle();
}

export function showAndFocusAuxiliaryWindow(window: BrowserWindow): void {
  if (window.isMinimized()) {
    window.restore();
  }
  window.show();
  if (supportsMoveTop) {
    window.moveTop();
  } else {
    pulseAuxiliaryWindowToTop(window);
  }
  window.focus();
}

function pulseAuxiliaryWindowToTop(window: BrowserWindow): void {
  const wasAlwaysOnTop = window.isAlwaysOnTop();
  window.setAlwaysOnTop(true);
  setTimeout(() => {
    if (window.isDestroyed() || wasAlwaysOnTop) {
      return;
    }
    window.setAlwaysOnTop(false);
  }, 250);
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
