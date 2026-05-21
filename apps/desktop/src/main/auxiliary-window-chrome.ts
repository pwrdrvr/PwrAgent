import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
} from "electron";

const supportsPerWindowMenuBar =
  process.platform === "linux" || process.platform === "win32";
const supportsMoveTop = process.platform !== "linux";
const linuxRaiseRetryDelaysMs = [100, 350, 800] as const;
const firstOpenFallbackDelayMs = 1_000;
const postLoadRaiseDelayMs = 100;

const hiddenMenuBarWindows = new Set<BrowserWindow>();
const auxiliaryWindowTitles = new Map<number, string>();
const auxiliaryWindowRaiseRetryTimers = new Map<
  number,
  Array<ReturnType<typeof setTimeout>>
>();

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
  raiseAuxiliaryWindow(window);
  scheduleAuxiliaryWindowRaiseRetries(window);
}

export function showAuxiliaryWindowWhenReady(window: BrowserWindow): void {
  let shown = false;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let postLoadTimer: ReturnType<typeof setTimeout> | undefined;

  const clearFirstOpenTimers = (): void => {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = undefined;
    }
    if (postLoadTimer) {
      clearTimeout(postLoadTimer);
      postLoadTimer = undefined;
    }
  };

  const showOnce = (): void => {
    if (shown) return;

    shown = true;
    clearFirstOpenTimers();
    showAndFocusAuxiliaryWindow(window);
  };

  window.once("ready-to-show", showOnce);
  window.webContents.once("did-finish-load", () => {
    if (shown) return;

    postLoadTimer = setTimeout(showOnce, postLoadRaiseDelayMs);
  });
  fallbackTimer = setTimeout(showOnce, firstOpenFallbackDelayMs);

  window.once("closed", () => {
    clearFirstOpenTimers();
  });
}

function raiseAuxiliaryWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) {
    return;
  }
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

function scheduleAuxiliaryWindowRaiseRetries(window: BrowserWindow): void {
  if (supportsMoveTop) return;

  clearAuxiliaryWindowRaiseRetries(window);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  for (const [index, delayMs] of linuxRaiseRetryDelaysMs.entries()) {
    const timer = setTimeout(() => {
      if (auxiliaryWindowRaiseRetryTimers.get(window.id) !== timers) {
        return;
      }
      if (window.isDestroyed()) {
        clearAuxiliaryWindowRaiseRetries(window);
        return;
      }
      raiseAuxiliaryWindow(window);
      if (index === linuxRaiseRetryDelaysMs.length - 1) {
        auxiliaryWindowRaiseRetryTimers.delete(window.id);
      }
    }, delayMs);
    timers.push(timer);
  }
  auxiliaryWindowRaiseRetryTimers.set(window.id, timers);
  window.once("closed", () => {
    clearAuxiliaryWindowRaiseRetries(window);
  });
}

function clearAuxiliaryWindowRaiseRetries(window: BrowserWindow): void {
  const timers = auxiliaryWindowRaiseRetryTimers.get(window.id);
  if (!timers) return;

  for (const timer of timers) {
    clearTimeout(timer);
  }
  auxiliaryWindowRaiseRetryTimers.delete(window.id);
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
