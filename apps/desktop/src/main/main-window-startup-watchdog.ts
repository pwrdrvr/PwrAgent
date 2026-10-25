import { app, type BrowserWindow } from "electron";
import { getMainLogger } from "./log";

const mainLog = getMainLogger("pwragent:main");

/**
 * How long a new main window may stay hidden before the watchdog steps in.
 *
 * A main window is created hidden and shown on `ready-to-show`, its first
 * non-empty paint. A page that never gets that far leaves the app running
 * with no visible window and nothing in the log. 1.3.2 did exactly that on
 * one machine until the operator found the hidden window and reloaded it.
 */
export const MAIN_WINDOW_APPEAR_TIMEOUT_MS = 20_000;

type LoadMilestone =
  | "did-start-loading"
  | "dom-ready"
  | "did-finish-load"
  | "ready-to-show";

/**
 * Watch a hidden main window until it appears.
 *
 * At the deadline it logs where the page load got to, then shows the window
 * so the operator has a window and its Reload command. A page that has not
 * even parsed its document is reloaded once. It never raises a dialog: macOS
 * can hold back the first paint while the login session is locked, and #1887
 * removed a startup-timeout dialog that fired in that case.
 */
export function watchMainWindowStartup(
  window: BrowserWindow,
  options: {
    isShown: () => boolean;
    show: () => void;
    timeoutMs?: number;
  },
): void {
  const timeoutMs = options.timeoutMs ?? MAIN_WINDOW_APPEAR_TIMEOUT_MS;
  const contents = window.webContents;
  const createdAt = Date.now();
  const milestones: Partial<Record<LoadMilestone, number>> = {};
  const mark = (milestone: LoadMilestone) => {
    milestones[milestone] ??= Date.now() - createdAt;
  };
  let reloadedAt: number | undefined;
  let loadedSinceReload = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const state = (): Record<string, unknown> => {
    const rendererPid = contents.getOSProcessId();
    const metric = app.getAppMetrics().find((entry) => entry.pid === rendererPid);
    return {
      elapsedMs: Date.now() - createdAt,
      milestones: { ...milestones },
      url: contents.getURL(),
      isLoading: contents.isLoading(),
      isWaitingForResponse: contents.isWaitingForResponse(),
      isCrashed: contents.isCrashed(),
      rendererPid,
      rendererCpuPercent: metric?.cpu.percentCPUUsage,
    };
  };

  contents.on("did-start-loading", () => mark("did-start-loading"));
  contents.on("dom-ready", () => mark("dom-ready"));
  contents.on("did-finish-load", () => {
    mark("did-finish-load");
    if (reloadedAt !== undefined) loadedSinceReload = true;
  });
  window.once("ready-to-show", () => mark("ready-to-show"));
  // A hung renderer otherwise leaves no trace in the log.
  contents.on("unresponsive", () => {
    mainLog.warn("main window renderer unresponsive", state());
  });
  contents.on("responsive", () => {
    mainLog.info("main window renderer responsive again", {
      elapsedMs: Date.now() - createdAt,
    });
  });

  const arm = (check: () => void) => {
    timer = setTimeout(() => {
      timer = undefined;
      if (window.isDestroyed()) return;
      check();
    }, timeoutMs);
    timer.unref?.();
  };

  arm(() => {
    if (options.isShown()) return;
    const parsed = milestones["dom-ready"] !== undefined;
    mainLog.warn("main window has not appeared; showing it", {
      ...state(),
      timeoutMs,
      reloading: !parsed,
    });
    if (!parsed) {
      reloadedAt = Date.now();
      contents.reload();
      arm(() => {
        if (loadedSinceReload) return;
        mainLog.error("main window has not loaded after a reload", {
          ...state(),
          sinceReloadMs: Date.now() - (reloadedAt ?? createdAt),
        });
      });
    }
    options.show();
  });

  window.once("closed", () => {
    if (timer) clearTimeout(timer);
  });
}
