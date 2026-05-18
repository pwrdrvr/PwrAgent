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
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;

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

function productionUpdatesEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}

function developmentUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "auto-update disabled in development",
  };
}

function preserveDownloadedStatus(nextStatus: AppUpdateStatus): boolean {
  if (updateStatus.status !== "downloaded") {
    return false;
  }
  return (
    nextStatus.status === "checking" ||
    nextStatus.status === "no-update" ||
    nextStatus.status === "error"
  );
}

function setUpdateStatusUnlessDownloaded(nextStatus: AppUpdateStatus): void {
  const currentStatus = updateStatus;
  if (
    currentStatus.status === "downloaded" &&
    preserveDownloadedStatus(nextStatus)
  ) {
    log.info("keeping downloaded update status during follow-up check", {
      currentVersion: currentStatus.version,
      nextStatus: nextStatus.status,
    });
    return;
  }
  setUpdateStatus(nextStatus);
}

export async function checkForAppUpdatesNow(
  trigger: "startup" | "periodic" | "manual" | "menu" = "manual",
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    const result = developmentUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (updateCheckInFlight) {
    log.info("joining in-flight update check", { trigger });
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
    try {
      log.info("checking for app updates", { trigger });
      configureAutoUpdaterChannel();
      const result = await autoUpdater.checkForUpdates();
      if (updateStatus.status === "downloaded") {
        return { status: "downloaded", version: updateStatus.version };
      }
      if (!result || !result.updateInfo) {
        return {
          status: "no-update",
          version: result?.updateInfo?.version ?? "unknown",
        };
      }
      const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
      if (result.updateInfo.version === currentVersion) {
        return { status: "no-update", version: currentVersion };
      }
      return { status: "available", version: result.updateInfo.version };
    } catch (err) {
      const result = {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      } as const;
      setUpdateStatusUnlessDownloaded(result);
      log.warn("checkForUpdates failed", {
        message: result.message,
        trigger,
      });
      return result;
    } finally {
      updateCheckInFlight = undefined;
    }
  })();

  return updateCheckInFlight;
}

function startPeriodicUpdateChecks(): void {
  if (periodicUpdateCheckTimer) {
    return;
  }
  periodicUpdateCheckTimer = setInterval(() => {
    void checkForAppUpdatesNow("periodic");
  }, APP_UPDATE_CHECK_INTERVAL_MS);
  periodicUpdateCheckTimer.unref?.();
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

type ParsedSemver = {
  core: [number, number, number];
  pre: Array<string | number>;
};

function parseSemver(tag: string | undefined): ParsedSemver | undefined {
  if (!tag) return undefined;
  const trimmed = tag.trim().replace(/^v/i, "");
  const match = trimmed.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
  );
  if (!match) return undefined;
  const [, maj, min, patch, pre] = match;
  return {
    core: [Number(maj), Number(min), Number(patch)],
    pre: pre
      ? pre.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part))
      : [],
  };
}

// Semver 2.0.0 precedence. Returns positive if a > b, negative if a < b.
// Unparseable tags sort below any valid version so they cannot win a "highest"
// selection over a real release.
export function compareSemver(a: string | undefined, b: string | undefined): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i];
  }
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  // A version without prerelease identifiers has higher precedence than one
  // with them (SemVer rule 11).
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const ai = pa.pre[i];
    const bi = pb.pre[i];
    if (ai === undefined) return -1;
    if (bi === undefined) return 1;
    if (typeof ai === "number" && typeof bi === "number") {
      if (ai !== bi) return ai - bi;
    } else if (typeof ai === "number") {
      return -1;
    } else if (typeof bi === "number") {
      return 1;
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

// Resolve channel slots by semver precedence, not GitHub publish order:
//   - `latest`     → highest-precedence release that is NOT a prerelease
//   - `prerelease` → highest-precedence release across both pools
// Reporting `max(stable, prerelease)` for the prerelease slot guarantees the
// prerelease channel never advertises a version older than `latest`. When no
// newer prerelease exists, both slots show the same version, which truthfully
// reflects what the updater would install.
export function selectChannelReleases(
  releases: GitHubRelease[],
): { latest: GitHubRelease | undefined; prerelease: GitHubRelease | undefined } {
  const publicReleases = releases.filter((release) => release.draft !== true);
  const byPrecedenceDesc = [...publicReleases].sort((a, b) =>
    compareSemver(b.tag_name, a.tag_name),
  );
  const latest = byPrecedenceDesc.find((release) => release.prerelease !== true);
  const prerelease = byPrecedenceDesc[0];
  return { latest, prerelease };
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
    const { latest, prerelease } = selectChannelReleases(releases);
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
  if (!productionUpdatesEnabled()) {
    log.info("auto-update disabled in non-production");
    setUpdateStatus(developmentUpdateCheckResult());
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
    setUpdateStatusUnlessDownloaded({ status: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    setUpdateStatus({ status: "available", version: info.version });
  });
  autoUpdater.on("update-not-available", (info) => {
    log.info("update-not-available", { version: info.version });
    setUpdateStatusUnlessDownloaded({ status: "no-update", version: info.version });
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
    setUpdateStatusUnlessDownloaded({ status: "error", message: err.message });
  });

  startPeriodicUpdateChecks();
  void checkForAppUpdatesNow("startup");
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
      return await checkForAppUpdatesNow("manual");
    },
  );
}

export function disposeAppUpdateIpcHandlers(): void {
  ipcMain.removeHandler(APP_UPDATE_CHECK_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_STATUS_READ_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_RELEASES_READ_CHANNEL);
}
