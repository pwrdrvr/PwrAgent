import type { BrowserWindow } from "electron";
import { getMainLogger } from "./log";
import { describeWebContentsLoad } from "./window-load-diagnostics";

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
 * Watch a new main window until its page loads and it is on screen.
 * `show` must be idempotent: the watchdog calls it whenever the page is ready
 * for it, including for a window that already appeared.
 *
 * At the deadline it logs where the page load got to. A page that loaded but
 * never painted is shown. A page that never parsed its document is reloaded
 * once and shown when the reload finishes, so anything that treats `show` as
 * "the renderer is ready" (federation viewers, the initial thread) reaches a
 * loaded page. If the reload stalls too, the window is shown anyway.
 *
 * It never raises a dialog: macOS can hold back the first paint while the
 * login session is locked, and #1887 removed a startup-timeout dialog that
 * fired in that case.
 */
export function watchMainWindowStartup(
  window: BrowserWindow,
  options: {
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
  let reloading = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const state = (): Record<string, unknown> => ({
    elapsedMs: Date.now() - createdAt,
    milestones: { ...milestones },
    visible: window.isVisible(),
    ...describeWebContentsLoad(contents),
  });

  contents.on("did-start-loading", () => mark("did-start-loading"));
  contents.on("dom-ready", () => mark("dom-ready"));
  contents.on("did-finish-load", () => {
    mark("did-finish-load");
    if (!reloading) return;
    reloading = false;
    if (timer) clearTimeout(timer);
    mainLog.info("main window loaded after a reload", state());
    options.show();
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
    if (milestones["dom-ready"] !== undefined) {
      // Loaded. Normally already shown; otherwise it never painted.
      if (!window.isVisible()) {
        mainLog.warn("main window has not appeared; showing it", {
          ...state(),
          timeoutMs,
        });
      }
      options.show();
      return;
    }
    // Reload even a window something else already showed: Settings shows
    // the main window directly, which leaves a stalled page on screen.
    mainLog.warn("main window page has not loaded; reloading it", {
      ...state(),
      timeoutMs,
    });
    reloading = true;
    contents.reload();
    arm(() => {
      if (!reloading) return;
      mainLog.error("main window has not loaded after a reload; showing it", {
        ...state(),
        timeoutMs,
      });
      options.show();
    });
  });

  window.once("closed", () => {
    if (timer) clearTimeout(timer);
  });
}
