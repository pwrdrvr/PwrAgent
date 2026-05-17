import { BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import {
  APP_UPDATE_CHECK_CHANNEL,
  APP_UPDATE_INSTALL_CHANNEL,
  APP_UPDATE_RELEASES_READ_CHANNEL,
  APP_UPDATE_STATUS_EVENT_CHANNEL,
  APP_UPDATE_STATUS_READ_CHANNEL,
} from "../shared/ipc";
import type {
  AppUpdateCheckResult,
  AppUpdateInstallResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../shared/app-metadata";
import { getMainLogger } from "./log";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";

const log = getMainLogger("pwragent:updater");
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/pwrdrvr/PwrAgent/releases?per_page=30";
const RELEASE_FETCH_TIMEOUT_MS = 5_000;

let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };

type GitHubRelease = {
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

function setUpdateStatus(nextStatus: AppUpdateStatus): void {
  updateStatus = nextStatus;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(APP_UPDATE_STATUS_EVENT_CHANNEL, nextStatus);
  }
}

function downloadedVersion(): string | undefined {
  return updateStatus.status === "downloaded" ? updateStatus.version : undefined;
}

function currentUpdateChannel(): "latest" | "prerelease" {
  try {
    return getDesktopSettingsService().resolveUpdateChannel();
  } catch (err) {
    log.warn("failed to read update channel setting", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "latest";
  }
}

function configureAutoUpdaterChannel(): void {
  const updateChannel = currentUpdateChannel();
  autoUpdater.allowPrerelease = updateChannel === "prerelease";
  log.info("configured auto-update channel", {
    allowPrerelease: autoUpdater.allowPrerelease,
    updateChannel,
  });
}

function releaseInfoFromGitHubRelease(
  release: GitHubRelease | undefined,
  unavailableReason: string,
): AppUpdateReleaseInfo {
  if (!release?.tag_name) {
    return { unavailableReason };
  }
  return {
    version: release.tag_name,
    ...(release.name ? { name: release.name } : {}),
    ...(release.html_url ? { url: release.html_url } : {}),
    ...(release.published_at ? { publishedAt: release.published_at } : {}),
  };
}

function githubReleaseHeaders(): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrAgent",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: githubReleaseHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`GitHub releases request failed with ${response.status}`);
    }
    const payload = await response.json();
    const releases = Array.isArray(payload)
      ? payload.filter((release): release is GitHubRelease =>
          typeof release === "object" && release !== null,
        )
      : [];
    const publicReleases = releases.filter((release) => release.draft !== true);
    const latest = publicReleases.find(
      (release) => release.prerelease !== true,
    );
    const prerelease = publicReleases.find(
      (release) => release.prerelease === true,
    );
    return {
      fetchedAt: Date.now(),
      latest: releaseInfoFromGitHubRelease(latest, "No stable release found."),
      prerelease: releaseInfoFromGitHubRelease(
        prerelease,
        "No prerelease found.",
      ),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      fetchedAt: Date.now(),
      latest: { unavailableReason: message },
      prerelease: { unavailableReason: message },
    };
  } finally {
    clearTimeout(timeout);
  }
}

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
    setUpdateStatus({
      status: "skipped",
      reason: "auto-update disabled in development",
    });
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
  configureAutoUpdaterChannel();

  autoUpdater.on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatus({ status: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    setUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    log.info("update-not-available", { version: info.version });
    setUpdateStatus({ status: "no-update", version: info.version });
  });
  autoUpdater.on("download-progress", (progress) => {
    log.info("download-progress", {
      percent: Math.round(progress.percent),
      transferred: progress.transferred,
      total: progress.total,
    });
    const version =
      updateStatus.status === "available" || updateStatus.status === "downloading"
        ? updateStatus.version
        : "unknown";
    setUpdateStatus({
      status: "downloading",
      version,
      percent: Math.round(progress.percent),
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    log.info("update-downloaded", { version: info.version });
    setUpdateStatus({ status: "downloaded", version: info.version });
  });
  autoUpdater.on("error", (err: Error) => {
    log.warn("auto-update error", { message: err.message });
    setUpdateStatus({ status: "error", message: err.message });
  });

  autoUpdater
    .checkForUpdates()
    .catch((err) => {
      setUpdateStatus({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      log.warn("checkForUpdates failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
}

export function registerAppUpdateIpcHandlers(): void {
  ipcMain.removeHandler(APP_UPDATE_CHECK_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_STATUS_READ_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_RELEASES_READ_CHANNEL);
  ipcMain.handle(
    APP_UPDATE_STATUS_READ_CHANNEL,
    async (): Promise<AppUpdateStatus> => updateStatus,
  );
  ipcMain.handle(
    APP_UPDATE_RELEASES_READ_CHANNEL,
    async (): Promise<AppUpdateReleaseVersions> =>
      await readAppUpdateReleaseVersions(),
  );
  ipcMain.handle(
    APP_UPDATE_INSTALL_CHANNEL,
    async (): Promise<AppUpdateInstallResult> => {
      const version = downloadedVersion();
      if (!version) {
        return {
          status: "error",
          message: "No downloaded update is ready to install.",
        };
      }
      try {
        log.info("installing downloaded update", { version });
        autoUpdater.quitAndInstall();
        return { status: "restarting" };
      } catch (err) {
        return {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );
  ipcMain.handle(
    APP_UPDATE_CHECK_CHANNEL,
    async (): Promise<AppUpdateCheckResult> => {
      if (process.env.NODE_ENV !== "production") {
        const result = {
          status: "skipped",
          reason: "auto-update disabled in development",
        } as const;
        setUpdateStatus(result);
        return result;
      }
      try {
        configureAutoUpdaterChannel();
        const result = await autoUpdater.checkForUpdates();
        if (updateStatus.status === "downloaded") {
          return { status: "downloaded", version: updateStatus.version };
        }
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
  ipcMain.removeHandler(APP_UPDATE_STATUS_READ_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_RELEASES_READ_CHANNEL);
}
