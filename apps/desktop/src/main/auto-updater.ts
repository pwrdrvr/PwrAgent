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
import type {
  DesktopUpdateChannel,
  DesktopUpdateTrain,
} from "@pwragent/shared";
import { getMainLogger } from "./log";
import { getDesktopSettingsService } from "./settings/desktop-settings-singleton";
import {
  markUpdateInstallInProgress,
  markUpdateInstallUpdaterQuitReady,
  prepareForUpdateInstall,
} from "./update-install-state";

const log = getMainLogger("pwragent:updater");
const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/pwrdrvr/PwrAgent/releases?per_page=30";
const RELEASE_FETCH_TIMEOUT_MS = 5_000;
export const APP_UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;

let initialized = false;
let updateStatus: AppUpdateStatus = { status: "idle" };
let periodicUpdateCheckTimer: ReturnType<typeof setInterval> | undefined;
let updateCheckInFlight: Promise<AppUpdateCheckResult> | undefined;
type UpdateSelectionKey = `${DesktopUpdateTrain}:${DesktopUpdateChannel}`;

let updateCheckChannelInFlight: UpdateSelectionKey | undefined;
let heldDownloadedUpdate:
  | { selection: UpdateSelectionKey; version: string }
  | undefined;
const pendingDownloadChannelsByVersion = new Map<string, UpdateSelectionKey>();

type GitHubRelease = {
  assets?: GitHubReleaseAsset[];
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
};

type GitHubReleaseAsset = {
  name?: string;
  state?: string;
};

const MAC_UPDATE_CHANNEL_FILE = "latest-mac.yml";

function setUpdateStatus(nextStatus: AppUpdateStatus): void {
  updateStatus = nextStatus;
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(APP_UPDATE_STATUS_EVENT_CHANNEL, nextStatus);
  }
}

export function readAppUpdateStatus(): AppUpdateStatus {
  reconcileDownloadedUpdateEligibility();
  return updateStatus;
}

function currentUpdateChannel(): DesktopUpdateChannel {
  try {
    return getDesktopSettingsService().resolveUpdateChannel();
  } catch (err) {
    log.warn("failed to read update channel setting", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "latest";
  }
}

function currentUpdateTrain(): DesktopUpdateTrain {
  try {
    return getDesktopSettingsService().resolveUpdateTrain();
  } catch (err) {
    log.warn("failed to read update train setting", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "stable";
  }
}

function updateSelectionKey(
  updateTrain: DesktopUpdateTrain,
  updateChannel: DesktopUpdateChannel,
): UpdateSelectionKey {
  return `${updateTrain}:${updateChannel}`;
}

function currentUpdateSelectionKey(): UpdateSelectionKey {
  return updateSelectionKey(currentUpdateTrain(), currentUpdateChannel());
}

function configureAutoUpdaterChannel(
  updateChannel: DesktopUpdateChannel = currentUpdateChannel(),
  updateTrain: DesktopUpdateTrain = currentUpdateTrain(),
): void {
  autoUpdater.allowPrerelease =
    updateTrain === "beta" || updateChannel === "prerelease";
  log.info("configured auto-update channel", {
    allowPrerelease: autoUpdater.allowPrerelease,
    updateChannel,
    updateTrain,
  });
}

function configureAutoUpdaterFeedForRelease(release: GitHubRelease): void {
  const tag = release.tag_name;
  if (!tag) {
    return;
  }
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `https://github.com/pwrdrvr/PwrAgent/releases/download/${encodeURIComponent(tag)}/`,
  });
  log.info("configured auto-update feed for GitHub release", { tag });
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

function linuxManualPackageUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "Linux builds are updated by installing a newer package.",
  };
}

function linuxManualPackageUpdatesEnabled(): boolean {
  return process.platform === "linux";
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
  const eligibleDownload = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey(),
  );
  if (eligibleDownload && preserveDownloadedStatus(nextStatus)) {
    log.info("keeping downloaded update status during follow-up check", {
      currentVersion: eligibleDownload.version,
      nextStatus: nextStatus.status,
    });
    return;
  }
  setUpdateStatus(nextStatus);
}

function downloadedUpdateMatchesChannel(
  updateSelection: UpdateSelectionKey,
): Extract<AppUpdateCheckResult, { status: "downloaded" }> | undefined {
  if (heldDownloadedUpdate?.selection !== updateSelection) {
    return undefined;
  }
  return { status: "downloaded", version: heldDownloadedUpdate.version };
}

function syncAutoInstallOnAppQuit(updateSelection: UpdateSelectionKey): void {
  autoUpdater.autoInstallOnAppQuit =
    downloadedUpdateMatchesChannel(updateSelection) !== undefined
    || heldDownloadedUpdate === undefined;
}

function reconcileDownloadedUpdateEligibility(
  updateSelection: UpdateSelectionKey = currentUpdateSelectionKey(),
): void {
  const eligibleDownload = downloadedUpdateMatchesChannel(updateSelection);
  syncAutoInstallOnAppQuit(updateSelection);
  if (eligibleDownload) {
    if (
      updateStatus.status !== "downloaded"
      || updateStatus.version !== eligibleDownload.version
    ) {
      setUpdateStatus(eligibleDownload);
    }
    return;
  }
  if (updateStatus.status === "downloaded") {
    const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
    log.info("hiding downloaded update from the unselected train", {
      currentVersion,
      heldSelection: heldDownloadedUpdate?.selection,
      heldVersion: heldDownloadedUpdate?.version,
      updateSelection,
    });
    setUpdateStatus({ status: "no-update", version: currentVersion });
  }
}

function recordPendingDownloadChannel(
  version: string | undefined,
  updateSelection: UpdateSelectionKey | undefined,
): void {
  if (!version || !updateSelection) {
    return;
  }
  pendingDownloadChannelsByVersion.set(version, updateSelection);
}

export async function checkForAppUpdatesNow(
  trigger: "startup" | "periodic" | "manual" | "menu" = "manual",
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    const result = developmentUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (linuxManualPackageUpdatesEnabled()) {
    const result = linuxManualPackageUpdateCheckResult();
    setUpdateStatus(result);
    return result;
  }

  if (updateCheckInFlight) {
    log.info("joining in-flight update check", { trigger });
    return updateCheckInFlight;
  }

  updateCheckInFlight = (async () => {
    try {
      const updateChannel = currentUpdateChannel();
      const updateTrain = currentUpdateTrain();
      const updateSelection = updateSelectionKey(updateTrain, updateChannel);
      reconcileDownloadedUpdateEligibility(updateSelection);
      const downloadedResult = downloadedUpdateMatchesChannel(updateSelection);
      if (downloadedResult) {
        log.info("skipping app update check; update already downloaded", {
          trigger,
          updateChannel,
          updateTrain,
          version: downloadedResult.version,
        });
        return downloadedResult;
      }
      log.info("checking for app updates", { trigger });
      configureAutoUpdaterChannel(updateChannel, updateTrain);
      const release = await readAppUpdateReleaseForChannel(
        updateChannel,
        updateTrain,
      );
      const currentVersion = autoUpdater.currentVersion?.version ?? "unknown";
      if (!release?.tag_name) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessDownloaded(result);
        log.info("skipping app update check; no valid GitHub release found", {
          trigger,
          updateChannel,
          updateTrain,
        });
        return result;
      }
      const selectedVersion = release.tag_name.replace(/^v/i, "");
      if (compareSemver(selectedVersion, currentVersion) <= 0) {
        const result = { status: "no-update", version: currentVersion } as const;
        setUpdateStatusUnlessDownloaded(result);
        log.info("skipping app update check; selected release is not newer", {
          currentVersion,
          selectedRelease: release.tag_name,
          trigger,
          updateChannel,
          updateTrain,
        });
        return result;
      }
      configureAutoUpdaterFeedForRelease(release);
      updateCheckChannelInFlight = updateSelection;
      const result = await autoUpdater.checkForUpdates();
      if (result?.updateInfo?.version !== currentVersion) {
        recordPendingDownloadChannel(result?.updateInfo?.version, updateSelection);
      }
      const matchingDownloadedResult = downloadedUpdateMatchesChannel(updateSelection);
      if (matchingDownloadedResult) {
        return matchingDownloadedResult;
      }
      if (!result || !result.updateInfo) {
        return {
          status: "no-update",
          version: result?.updateInfo?.version ?? "unknown",
        };
      }
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
      updateCheckChannelInFlight = undefined;
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

function compareSemverCore(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function firstPrereleaseId(tag: string | undefined): string | undefined {
  const parsed = parseSemver(tag);
  if (!parsed || parsed.pre.length === 0) {
    return undefined;
  }
  return typeof parsed.pre[0] === "string" ? parsed.pre[0] : undefined;
}

function isBetaLatestRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[],
): boolean {
  if (release.prerelease !== true) {
    return false;
  }
  const parsed = parseSemver(release.tag_name);
  if (!parsed || parsed.pre[0] !== "beta") {
    return false;
  }
  const stableCore = parseSemver(stableLatest?.tag_name)?.core;
  if (stableCore && compareSemverCore(parsed.core, stableCore) > 0) {
    return true;
  }
  return releases.some((candidate) => {
    if (candidate.draft === true) {
      return false;
    }
    const other = parseSemver(candidate.tag_name);
    return (
      other !== undefined
      && compareSemverCore(other.core, parsed.core) === 0
      && other.pre[0] === "alpha"
    );
  });
}

export type SelectedUpdateReleases = {
  latest: GitHubRelease | undefined;
  prerelease: GitHubRelease | undefined;
  stableLatest: GitHubRelease | undefined;
  stablePrerelease: GitHubRelease | undefined;
  betaLatest: GitHubRelease | undefined;
  betaPrerelease: GitHubRelease | undefined;
};

// Resolve slots by semver identifier and GitHub Latest, not publish order:
//   - stable latest      → highest GitHub non-prerelease (the 1.0 / normie feed)
//   - stable prerelease  → max(stable latest, 1.0 `-prerelease` / legacy `-beta`)
//   - beta latest        → highest `-beta` whose core is ahead of stable,
//                          or that has a same-core `-alpha` to promote from
//   - beta prerelease    → max(beta latest, highest `-alpha`)
// Legacy `v1.0.0-beta.N` GitHub prereleases stay on the stable prerelease
// track so existing `channel = "prerelease"` configs keep following them.
export function selectChannelReleases(
  releases: GitHubRelease[],
): SelectedUpdateReleases {
  const publicReleases = releases.filter((release) => release.draft !== true);
  const byPrecedenceDesc = [...publicReleases].sort((a, b) =>
    compareSemver(b.tag_name, a.tag_name),
  );
  const stableLatest = byPrecedenceDesc.find(
    (release) => release.prerelease !== true,
  );
  const betaLatest = byPrecedenceDesc.find((release) =>
    isBetaLatestRelease(release, stableLatest, publicReleases),
  );
  const stablePrerelease = byPrecedenceDesc.find((release) => {
    if (release === stableLatest) {
      return true;
    }
    if (release.prerelease !== true) {
      return false;
    }
    if (firstPrereleaseId(release.tag_name) === "alpha") {
      return false;
    }
    return !isBetaLatestRelease(release, stableLatest, publicReleases);
  });
  const betaPrerelease = byPrecedenceDesc.find((release) => {
    if (release === betaLatest) {
      return true;
    }
    return firstPrereleaseId(release.tag_name) === "alpha";
  });
  return {
    latest: stableLatest,
    prerelease: stablePrerelease,
    stableLatest,
    stablePrerelease,
    betaLatest,
    betaPrerelease,
  };
}

function hasUploadedReleaseAsset(
  release: GitHubRelease,
  predicate: (assetName: string) => boolean,
): boolean {
  return (
    release.assets?.some((asset) => {
      if (!asset.name || asset.state === "deleted") {
        return false;
      }
      return predicate(asset.name);
    }) ?? false
  );
}

function hasMacUpdateAssets(release: GitHubRelease): boolean {
  const hasChannelFile = hasUploadedReleaseAsset(
    release,
    (name) => name === MAC_UPDATE_CHANNEL_FILE,
  );
  const hasZip = hasUploadedReleaseAsset(release, (name) => name.endsWith(".zip"));
  return hasChannelFile && hasZip;
}

export function selectAppUpdateReleases(
  releases: GitHubRelease[],
): SelectedUpdateReleases {
  return selectChannelReleases(releases.filter(hasMacUpdateAssets));
}

function releaseForSelection(
  selected: SelectedUpdateReleases,
  updateChannel: DesktopUpdateChannel,
  updateTrain: DesktopUpdateTrain,
): GitHubRelease | undefined {
  if (updateTrain === "beta") {
    return updateChannel === "prerelease"
      ? selected.betaPrerelease
      : selected.betaLatest;
  }
  return updateChannel === "prerelease"
    ? selected.stablePrerelease
    : selected.stableLatest;
}

function githubReleaseHeaders(): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrAgent",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function fetchGitHubReleases(signal?: AbortSignal): Promise<GitHubRelease[]> {
  const response = await fetch(GITHUB_RELEASES_URL, {
    headers: githubReleaseHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with ${response.status}`);
  }
  const payload = await response.json();
  return Array.isArray(payload)
    ? payload.filter((release): release is GitHubRelease =>
        typeof release === "object" && release !== null,
      )
    : [];
}

async function readAppUpdateReleaseForChannel(
  updateChannel: DesktopUpdateChannel,
  updateTrain: DesktopUpdateTrain,
): Promise<GitHubRelease | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const releases = await fetchGitHubReleases(controller.signal);
    return releaseForSelection(
      selectAppUpdateReleases(releases),
      updateChannel,
      updateTrain,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const releases = await fetchGitHubReleases(controller.signal);
    const selected = selectAppUpdateReleases(releases);
    return {
      fetchedAt: Date.now(),
      stable: {
        latest: releaseInfoFromGitHubRelease(
          selected.stableLatest,
          "No stable release found.",
        ),
        prerelease: releaseInfoFromGitHubRelease(
          selected.stablePrerelease,
          "No stable prerelease found.",
        ),
      },
      beta: {
        latest: releaseInfoFromGitHubRelease(
          selected.betaLatest,
          "No beta release found.",
        ),
        prerelease: releaseInfoFromGitHubRelease(
          selected.betaPrerelease,
          "No beta prerelease found.",
        ),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const unavailable = { unavailableReason: message };
    return {
      fetchedAt: Date.now(),
      stable: { latest: unavailable, prerelease: unavailable },
      beta: { latest: unavailable, prerelease: unavailable },
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

  if (linuxManualPackageUpdatesEnabled()) {
    log.info("auto-update disabled for Linux package builds");
    setUpdateStatus(linuxManualPackageUpdateCheckResult());
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
  try {
    getDesktopSettingsService().onConfigWritten(() => {
      reconcileDownloadedUpdateEligibility();
    });
  } catch (err) {
    log.warn("failed to subscribe to update-selection setting changes", {
      message: err instanceof Error ? err.message : String(err),
    });
  }

  autoUpdater.on("checking-for-update", () => {
    log.info("checking-for-update");
    setUpdateStatusUnlessDownloaded({ status: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    log.info("update-available", { version: info.version });
    recordPendingDownloadChannel(info.version, updateCheckChannelInFlight);
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
    const selection = info.version
      ? pendingDownloadChannelsByVersion.get(info.version)
        ?? currentUpdateSelectionKey()
      : undefined;
    if (info.version) {
      pendingDownloadChannelsByVersion.delete(info.version);
    }
    if (info.version && selection) {
      heldDownloadedUpdate = {
        selection,
        version: info.version,
      };
    }
    reconcileDownloadedUpdateEligibility();
  });
  autoUpdater.on("error", (err: Error) => {
    log.warn("auto-update error", { message: err.message });
    setUpdateStatusUnlessDownloaded({ status: "error", message: err.message });
  });

  startPeriodicUpdateChecks();
  void checkForAppUpdatesNow("startup");
}

export async function installDownloadedAppUpdate(options?: {
  requestQuit?: (performQuit: () => void) => Promise<boolean>;
}): Promise<AppUpdateInstallResult> {
  const eligibleDownload = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey(),
  );
  const version = eligibleDownload?.version;
  if (!version) {
    return {
      status: "error",
      message: heldDownloadedUpdate
        ? "The downloaded update is not for the selected channel."
        : "No downloaded update is ready to install.",
    };
  }
  try {
    log.info("installing downloaded update", { version });
    let updateHandoffPromise: Promise<void> | undefined;
    const performQuit = (): void => {
      // The accepted update is now irreversible. Latch immediately so a user
      // closing the last window while teardown runs cannot start another quit.
      markUpdateInstallInProgress();
      updateHandoffPromise ??= prepareForUpdateInstall()
        .catch((error: unknown) => {
          // Teardown is bounded and normally resolves with phase outcomes, but
          // never strand an accepted update if an unexpected synchronous
          // cleanup error escapes. The updater still owns the eventual quit.
          log.warn("update-install preparation failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        })
        .then(() => {
          // From this point onward the updater owns before-quit. Set the ready
          // latch immediately before the synchronous native handoff.
          markUpdateInstallUpdaterQuitReady();
          autoUpdater.quitAndInstall();
        });
    };
    if (options?.requestQuit) {
      const quitAccepted = await options.requestQuit(performQuit);
      if (!quitAccepted) {
        return {
          status: "error",
          message: "Update restart cancelled.",
        };
      }
    } else {
      performQuit();
    }
    return { status: "restarting" };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function registerAppUpdateIpcHandlers(options?: {
  requestQuit?: (performQuit: () => void) => Promise<boolean>;
}): void {
  ipcMain.removeHandler(APP_UPDATE_CHECK_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_STATUS_READ_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_INSTALL_CHANNEL);
  ipcMain.removeHandler(APP_UPDATE_RELEASES_READ_CHANNEL);
  ipcMain.handle(
    APP_UPDATE_STATUS_READ_CHANNEL,
    async (): Promise<AppUpdateStatus> => {
      reconcileDownloadedUpdateEligibility();
      return updateStatus;
    },
  );
  ipcMain.handle(
    APP_UPDATE_RELEASES_READ_CHANNEL,
    async (): Promise<AppUpdateReleaseVersions> =>
      await readAppUpdateReleaseVersions(),
  );
  ipcMain.handle(
    APP_UPDATE_INSTALL_CHANNEL,
    async (): Promise<AppUpdateInstallResult> => {
      return await installDownloadedAppUpdate(options);
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
