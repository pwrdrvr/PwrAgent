import { ipcMain } from "electron";
import { autoUpdater } from "electron-updater";
import { APP_UPDATE_CHECK_CHANNEL } from "../shared/ipc";
import type { AppUpdateCheckResult } from "../shared/app-metadata";
import { getMainLogger } from "./log";

const log = getMainLogger("pwragnt:updater");

let initialized = false;

export function initAutoUpdater(): void {
  if (initialized) {
    return;
  }
  initialized = true;

  // Skip in development. The dev binary isn't signed and Squirrel.Mac would
  // refuse to apply any update anyway. Skipping cleanly avoids spurious
  // 404s when running `pnpm dev` without a release feed.
  if (process.env.NODE_ENV !== "production") {
    log.info("auto-update disabled in non-production");
    return;
  }

  // Phase 1: rely on a runtime GH_TOKEN. The shipped binary deliberately does
  // NOT bake a token; the user (just one person during solo dogfooding)
  // launches the app with GH_TOKEN exported. Phase 2 distribution channel
  // migration removes the token entirely. See
  // docs/desktop-release-runbook.md.
  autoUpdater.logger = log as unknown as Console;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = true;

  autoUpdater.on("checking-for-update", () => log.info("checking-for-update"));
  autoUpdater.on("update-available", (info) =>
    log.info("update-available", { version: info.version }),
  );
  autoUpdater.on("update-not-available", (info) =>
    log.info("update-not-available", { version: info.version }),
  );
  autoUpdater.on("download-progress", (progress) =>
    log.info("download-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    log.info("update-downloaded", { version: info.version }),
  );
  autoUpdater.on("error", (err: Error) =>
    log.warn("auto-update error", { message: err.message }),
  );

  autoUpdater
    .checkForUpdatesAndNotify()
    .catch((err) =>
      log.warn("checkForUpdatesAndNotify failed", {
        message: err instanceof Error ? err.message : String(err),
      }),
    );
}

export function registerAppUpdateIpcHandlers(): void {
  ipcMain.removeHandler(APP_UPDATE_CHECK_CHANNEL);
  ipcMain.handle(
    APP_UPDATE_CHECK_CHANNEL,
    async (): Promise<AppUpdateCheckResult> => {
      if (process.env.NODE_ENV !== "production") {
        return { status: "skipped", reason: "auto-update disabled in development" };
      }
      try {
        const result = await autoUpdater.checkForUpdates();
        if (!result || !result.updateInfo) {
          return { status: "no-update", version: result?.updateInfo?.version ?? "unknown" };
        }
        const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
        if (result.updateInfo.version === currentVersion) {
          return { status: "no-update", version: currentVersion };
        }
        return { status: "available", version: result.updateInfo.version };
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
}

export function disposeAppUpdateIpcHandlers(): void {
  ipcMain.removeHandler(APP_UPDATE_CHECK_CHANNEL);
}
