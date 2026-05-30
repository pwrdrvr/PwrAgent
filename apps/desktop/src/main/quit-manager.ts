import { app, BrowserWindow } from "electron";
import { getDesktopBackendRegistry } from "./app-server/backend-registry";
import { getMainLogger } from "./log";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  showQuitConfirmationDialog,
  type QuitConfirmationDialogResult,
} from "./quit-confirmation-dialog";

export const QUIT_CONFIRMATION_COUNTDOWN_SECONDS = 10;

export type QuitRequestSource =
  | "before-quit"
  | "ipc"
  | "menu"
  | "signal"
  | "update-install"
  | "window-all-closed";

export type RequestQuitOptions = {
  performQuit?: () => void;
  source: QuitRequestSource;
};

export type QuitManagerDependencies = {
  confirm?: (params: {
    countdownSeconds: number;
    inProgressThreadCount: number;
    parent?: BrowserWindow | null;
  }) => Promise<QuitConfirmationDialogResult>;
  getConfirmationEnabled: () => boolean;
  getFocusedWindow?: () => BrowserWindow | null;
  getInProgressThreads: () => { count: number; threadIds: string[] };
  log: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
  };
  performQuit: () => void;
};

export type QuitManager = {
  allowImmediateQuit: () => void;
  isQuitAllowed: () => boolean;
  requestQuit: (options: RequestQuitOptions) => Promise<boolean>;
};

export function createQuitManager(
  dependencies: QuitManagerDependencies,
): QuitManager {
  let quitAllowed = false;
  let pendingPerformQuit: (() => void) | undefined;
  let promptPromise: Promise<boolean> | undefined;

  const requestQuit = async (options: RequestQuitOptions): Promise<boolean> => {
    if (quitAllowed) {
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    const snapshot = dependencies.getInProgressThreads();
    if (snapshot.count <= 0) {
      dependencies.log.info?.("quit requested with no in-progress threads", {
        source: options.source,
      });
      quitAllowed = true;
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    if (!dependencies.getConfirmationEnabled()) {
      dependencies.log.warn?.(
        "quit requested with in-progress threads; confirmation disabled",
        {
          count: snapshot.count,
          source: options.source,
          threadIds: snapshot.threadIds,
        },
      );
      quitAllowed = true;
      (options.performQuit ?? dependencies.performQuit)();
      return true;
    }

    if (promptPromise) {
      if (options.performQuit) {
        pendingPerformQuit = options.performQuit;
      }
      return await promptPromise;
    }

    dependencies.log.warn?.("quit requested with in-progress threads", {
      count: snapshot.count,
      source: options.source,
      threadIds: snapshot.threadIds,
    });

    pendingPerformQuit = options.performQuit ?? dependencies.performQuit;
    promptPromise = (async () => {
      const resolution = await (dependencies.confirm ?? showQuitConfirmationDialog)({
        countdownSeconds: QUIT_CONFIRMATION_COUNTDOWN_SECONDS,
        inProgressThreadCount: snapshot.count,
        parent: dependencies.getFocusedWindow?.(),
      });
      dependencies.log.warn?.("quit confirmation resolved", {
        count: snapshot.count,
        resolution,
        source: options.source,
        threadIds: snapshot.threadIds,
      });
      if (resolution === "manual-cancel") {
        pendingPerformQuit = undefined;
        return false;
      }
      quitAllowed = true;
      (pendingPerformQuit ?? dependencies.performQuit)();
      pendingPerformQuit = undefined;
      return true;
    })().finally(() => {
      promptPromise = undefined;
    });

    return await promptPromise;
  };

  return {
    allowImmediateQuit: () => {
      quitAllowed = true;
    },
    isQuitAllowed: () => quitAllowed,
    requestQuit,
  };
}

const quitLog = getMainLogger("pwragent:quit");

export const appQuitManager = createQuitManager({
  getConfirmationEnabled: () =>
    getDesktopSettingsService().resolveConfirmQuitWithInProgressThreads(),
  getFocusedWindow: () => BrowserWindow.getFocusedWindow(),
  getInProgressThreads: () =>
    getDesktopBackendRegistry().getInProgressThreadSnapshotForQuit(),
  log: quitLog,
  performQuit: () => {
    app.quit();
  },
});

export async function requestQuit(
  options: RequestQuitOptions,
): Promise<boolean> {
  return await appQuitManager.requestQuit(options);
}
