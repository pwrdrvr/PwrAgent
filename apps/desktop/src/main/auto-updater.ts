import { app, BrowserWindow, ipcMain } from "electron";
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;
import {
  APP_UPDATE_CANCEL_DOWNLOAD_CHANNEL,
  APP_UPDATE_CHECK_CHANNEL,
  APP_UPDATE_CHECK_RESULT_EVENT_CHANNEL,
  APP_UPDATE_INSTALL_CHANNEL,
  APP_UPDATE_RELEASES_READ_CHANNEL,
  APP_UPDATE_STATUS_EVENT_CHANNEL,
  APP_UPDATE_STATUS_READ_CHANNEL,
} from "../shared/ipc";
import type {
  AppUpdateCancelResult,
  AppUpdateCheckResult,
  AppUpdateDirection,
  AppUpdateInstallResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../shared/app-metadata";
import {
  DESKTOP_UPDATE_CHANNEL_DEFAULT,
  DESKTOP_UPDATE_TRAIN_DEFAULT,
  resolveDesktopUpdateSelection,
  type DesktopUpdateChannel,
  type DesktopUpdateSelection,
  type DesktopUpdateTrain,
} from "@pwragent/shared";
import { getMainLogger } from "./log";
import { getDesktopConfigStore } from "./settings/desktop-settings-singleton";
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
// The GitHub REST API allows 60 anonymous requests per hour per IP, shared by
// every process on the machine. The renderer reads release versions on every
// Settings mount, so main caches the release list and serves those reads from
// memory instead of spending a request each time.
export const APP_UPDATE_RELEASE_CACHE_TTL_MS = 15 * 60 * 1_000;
const RATE_LIMIT_FALLBACK_BACKOFF_MS = 15 * 60 * 1_000;

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

/**
 * The download the operator can still stop.
 *
 * Held rather than derived, for two reasons. `cancel` has to reach
 * electron-updater's own cancellation token, and the rejection that token
 * produces is indistinguishable from a network failure's unless we remember
 * that we were the ones who asked.
 *
 * Registered as soon as the check reaches `autoUpdater.checkForUpdates()` —
 * NOT when the bytes start moving. `update-available` is emitted from inside
 * that call and is the status that puts Cancel on screen, so registering any
 * later leaves a window in which the button is visible and does nothing: the
 * click marks the renderer `canceling`, finds no download here, and the
 * update installs anyway. `cancel` is therefore a mutable slot, filled in
 * once the token exists, and a flag already set is applied the moment it is.
 */
type ActiveUpdateDownload = {
  version: string;
  cancel: () => void;
  /** Set by `cancelAppUpdateDownload`, read wherever the download can stop. */
  canceled: boolean;
};

let activeDownload: ActiveUpdateDownload | undefined;

function releaseActiveDownload(download: ActiveUpdateDownload): void {
  if (activeDownload === download) {
    activeDownload = undefined;
  }
}

/**
 * Take a cancel the operator asked for before there was anything to ask.
 * Called wherever a download becomes stoppable, so a click that landed early
 * is honored instead of dropped.
 */
function applyPendingUpdateCancel(download: ActiveUpdateDownload): boolean {
  if (!download.canceled) {
    return false;
  }
  try {
    download.cancel();
  } catch (err) {
    log.warn("failed to apply a cancel requested before the download started", {
      message: err instanceof Error ? err.message : String(err),
      version: download.version,
    });
  }
  return true;
}

type ReleaseCacheEntry = {
  releases: GitHubRelease[];
  etag?: string;
  fetchedAt: number;
};

let releaseCache: ReleaseCacheEntry | undefined;
let releaseFetchInFlight: Promise<GitHubRelease[]> | undefined;
let rateLimitResetAt: number | undefined;

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

/**
 * Broadcast the outcome of a check the *operator* asked for.
 *
 * Deliberately a second channel rather than a richer status: every check
 * moves `APP_UPDATE_STATUS_EVENT_CHANNEL`, the hourly poll included, so the
 * status alone cannot tell a check someone is waiting on from one the hour
 * hand started. The live progress card is gated on this channel precisely so
 * a background download raises nothing.
 */
function emitUpdateCheckResult(result: AppUpdateCheckResult): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue;
    }
    window.webContents.send(APP_UPDATE_CHECK_RESULT_EVENT_CHANNEL, result);
  }
}

export function readAppUpdateStatus(): AppUpdateStatus {
  reconcileDownloadedUpdateEligibility();
  return updateStatus;
}

function currentUpdateChannel(): DesktopUpdateChannel {
  try {
    return currentUpdateSelection().channel;
  } catch (err) {
    log.warn("failed to read update channel setting", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "latest";
  }
}

function currentUpdateTrain(): DesktopUpdateTrain {
  try {
    return currentUpdateSelection().train;
  } catch (err) {
    log.warn("failed to read update train setting", {
      message: err instanceof Error ? err.message : String(err),
    });
    return "stable";
  }
}

// The feed resolves through the SAME function as the Settings snapshot.
// This used to carry its own copy of the rule, and a copy is how the two
// come apart: fixing the half-pair case in the settings service alone left
// Settings showing Beta Prerelease on a 1.1.0-alpha install while this
// function still answered Stable Latest and polled that feed forever.
function currentUpdateSelection(): DesktopUpdateSelection {
  return resolveDesktopUpdateSelection(
    getDesktopConfigStore().read("updates"),
    app.getVersion(),
  );
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

let lastLoggedUpdatePosture: string | null = null;

// `allowDowngrade` is the posture that lets an operator move *back* onto the
// channel they picked after ending up on a newer build than that channel
// serves. It stays alongside `allowPrerelease` so both halves of the feed
// posture are set — and logged — in one greppable place.
function configureAutoUpdaterChannel(
  updateChannel?: DesktopUpdateChannel,
  updateTrain?: DesktopUpdateTrain,
  options: { allowDowngrade?: boolean } = {},
): void {
  const current =
    updateChannel === undefined || updateTrain === undefined
      ? currentUpdateSelection()
      : undefined;
  updateChannel ??= current?.channel ?? DESKTOP_UPDATE_CHANNEL_DEFAULT;
  updateTrain ??= current?.train ?? DESKTOP_UPDATE_TRAIN_DEFAULT;
  autoUpdater.allowPrerelease =
    updateTrain === "beta" || updateChannel === "prerelease";
  autoUpdater.allowDowngrade = options.allowDowngrade === true;
  // Startup configures the channel and then every check reconfigures it, so
  // report the posture when it changes rather than once per update check. Both
  // halves are keyed: flipping `allowDowngrade` alone is a real posture change.
  const posture = `${updateSelectionKey(updateTrain, updateChannel)}:${autoUpdater.allowDowngrade}`;
  if (posture === lastLoggedUpdatePosture) {
    return;
  }

  lastLoggedUpdatePosture = posture;
  log.info("configured auto-update channel", {
    allowDowngrade: autoUpdater.allowDowngrade,
    allowPrerelease: autoUpdater.allowPrerelease,
    updateChannel,
    updateTrain,
  });
}

// Direction is derived from the running version rather than threaded through
// every call site, so the electron-updater event handlers — which only learn a
// version string — classify a build the same way the check flow does.
function updateDirectionForVersion(
  version: string | undefined,
): AppUpdateDirection | undefined {
  const currentVersion = autoUpdater.currentVersion?.version;
  // Both sides must parse. A placeholder such as the "unknown" the download
  // progress handler can carry sorts below every real version in
  // `compareSemver`, and must not be read as a downgrade.
  if (!parseSemver(version) || !parseSemver(currentVersion)) {
    return undefined;
  }
  return compareSemver(version, currentVersion) < 0 ? "downgrade" : undefined;
}

function withDirection<T extends { version: string }>(
  result: T,
): T & { direction?: AppUpdateDirection } {
  const direction = updateDirectionForVersion(result.version);
  return direction ? { ...result, direction } : result;
}

// Only an operator-initiated check may offer a downgrade. A background poll
// that nagged someone back down every hour would fight an operator who
// deliberately installed a newer build and left their channel alone; the
// Settings "Check for updates" button, the app menu item, and the app
// management tool are all explicit asks.
function downgradeOfferAllowed(trigger: UpdateCheckTrigger): boolean {
  return trigger === "manual" || trigger === "menu";
}

const UPDATE_TRAIN_LABEL: Record<DesktopUpdateTrain, string> = {
  stable: "Stable",
  beta: "Beta",
};

const UPDATE_CHANNEL_LABEL: Record<DesktopUpdateChannel, string> = {
  latest: "Latest",
  prerelease: "Prerelease",
};

/** Longest error we will put on screen. Past this the operator is reading
 *  diagnostics, not a report they can act on. */
const UPDATE_ERROR_MESSAGE_MAX = 200;

/**
 * electron-updater reports a failed feed read as ONE multi-kilobyte string:
 * the request URL, every response header, and a stack of packaged file
 * paths. Settings renders that message verbatim, so a single 404 filled the
 * pane with a wall of text an operator cannot act on — and response headers
 * are not ours to put on screen either. The whole error still goes to the
 * log; this is what the UI gets.
 */
function summarizeUpdateError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  // Both suffixes are appended to the same single line as the message, so a
  // plain first-line cut is not enough to drop them.
  const head = raw.split("\n")[0].split(" Headers: ")[0].trim();
  // A thrown `new Error()` carries an empty message, and returning it would
  // render "Update check failed:" with nothing after the colon. This is the
  // one choke point every update error passes through, so the fallback
  // belongs here rather than at each call site.
  if (head.length === 0) {
    return "The update check failed without reporting a reason.";
  }
  if (head.length <= UPDATE_ERROR_MESSAGE_MAX) {
    return head;
  }
  return `${head.slice(0, UPDATE_ERROR_MESSAGE_MAX - 1).trimEnd()}…`;
}

/**
 * The 404 above is worth naming rather than truncating, because it is not a
 * transport failure and a shorter version of the raw text would not say so.
 * `Cannot find channel "<file>" update info` means the GitHub release we
 * pointed the feed at carries no update manifest for THIS platform: the
 * release exists, the Settings matrix shows its version, and there is still
 * nothing installable in that slot. Saying which manifest is missing is the
 * one detail that makes the gap fixable.
 */
function describeUpdateCheckFailure(
  err: unknown,
  context: {
    channel: DesktopUpdateChannel;
    train: DesktopUpdateTrain;
    tag?: string;
  },
): string {
  // Trimmed before matching: `summarizeUpdateError` trims and this must
  // agree with it, or a message that arrives with a leading newline falls
  // through to the raw-text branch this function exists to avoid.
  const raw = (err instanceof Error ? err.message : String(err)).trim();
  const missingManifest = /^Cannot find channel "([^"]+)" update info/.exec(
    raw,
  )?.[1];
  if (!missingManifest) {
    return summarizeUpdateError(err);
  }
  const slot = `${UPDATE_TRAIN_LABEL[context.train]} ${UPDATE_CHANNEL_LABEL[context.channel]}`;
  const release = context.tag === undefined ? "" : ` (${context.tag})`;
  return `The ${slot} release${release} publishes no ${missingManifest} for this platform, so there is nothing to install from it yet.`;
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

// E2E launches the app with NODE_ENV=production, which would otherwise arm the
// startup check, the hourly timer, and the Settings release read against the
// live GitHub API. Every spinup would spend requests from the 60-per-hour
// anonymous budget shared by the whole runner IP, and the release list would
// make the UI depend on what happens to be published.
function e2eUpdateChecksDisabled(): boolean {
  return process.env.PWRAGENT_E2E === "1" && !app.isPackaged;
}

function productionUpdatesEnabled(): boolean {
  return process.env.NODE_ENV === "production" && !e2eUpdateChecksDisabled();
}

function developmentUpdateCheckResult(): AppUpdateCheckResult {
  return {
    status: "skipped",
    reason: "auto-update disabled in development",
  };
}

/** Dev-only opt-in for the fake update walk below. Listed in
 *  `rejectDevOnlyEnvVarsInProduction`, so a packaged build unsets it. */
export const PWRAGENT_DEV_FAKE_UPDATE_ENV = "PWRAGENT_DEV_FAKE_UPDATE";
/** Milliseconds per step of the fake. The Cancel button only exists
 *  mid-download, and at the default pace that window is a couple of seconds —
 *  comfortable by hand, a race on a loaded CI runner. */
export const PWRAGENT_DEV_FAKE_UPDATE_STEP_MS_ENV =
  "PWRAGENT_DEV_FAKE_UPDATE_STEP_MS";
/** Far enough above any real version that a previewed offer can never be
 *  mistaken for a genuine one. */
const DEV_FAKE_UPDATE_VERSION = "420.0.0";
/** Long enough to watch each transition land, short enough not to feel hung. */
const DEV_FAKE_UPDATE_DEFAULT_STEP_MS = 300;
/** Percent ticks the fake download reports. Enough of them that the meter is
 *  visibly a meter and Cancel has a window to be pressed in. */
const DEV_FAKE_UPDATE_PERCENT_STEPS = [0, 15, 34, 58, 79, 93, 100];
/** A plausible universal-mac zip, so the byte line is exercised too. */
const DEV_FAKE_UPDATE_TOTAL_BYTES = 118_000_000;

/**
 * Whether an operator-initiated check should walk the fake update machine
 * instead of answering `skipped`.
 *
 * Opt-in rather than "any unpackaged build" (which is how PwrGit gates its
 * own fake) for two PwrAgent-specific reasons. `pnpm dev` and the Playwright
 * harness both run unpackaged, and Settings → Updates is a real diagnostic
 * surface here — a fake v420.0.0 arriving unasked would sit on top of the
 * release matrix an operator is reading. And `checkForAppUpdatesNow("manual")`
 * is reachable from the app-management agent tool, which would otherwise
 * report a fabricated update to the user as fact.
 */
function devFakeUpdateCheckEnabled(): boolean {
  return (
    process.env[PWRAGENT_DEV_FAKE_UPDATE_ENV] === "1"
    && !app.isPackaged
  );
}

function devFakeUpdateStepMs(): number {
  const raw = Number(process.env[PWRAGENT_DEV_FAKE_UPDATE_STEP_MS_ENV]);
  return Number.isFinite(raw) && raw > 0
    ? raw
    : DEV_FAKE_UPDATE_DEFAULT_STEP_MS;
}

function devFakeUpdateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}

/**
 * Dev/QA stand-in for a real update check.
 *
 * Real auto-update only runs in packaged production builds — the dev binary
 * is unsigned and has no release feed — so the progress card, its byte meter,
 * and Cancel could not otherwise be seen without cutting a release. A
 * *user-initiated* check therefore walks the whole status machine to a fake
 * `downloaded@420.0.0`, broadcasting each transition.
 *
 * It ramps rather than emitting one sample because a meter cannot be judged
 * against a single frozen percent, and it honors Cancel at the same cadence a
 * real download does — otherwise the button is only ever exercised against
 * production code nobody can run in `pnpm dev`.
 *
 * Startup and periodic triggers stay silent so an opted-in dev launch never
 * raises a card on its own. Restart on the fake update is a no-op; see
 * `installDownloadedAppUpdate`.
 */
async function simulateDevUpdateCheck(
  trigger: UpdateCheckTrigger,
): Promise<AppUpdateCheckResult> {
  if (trigger !== "manual" && trigger !== "menu") {
    const skipped = developmentUpdateCheckResult();
    setUpdateStatus(skipped);
    return skipped;
  }
  // Join an in-flight simulation so mashing the menu item does not stack
  // overlapping walks racing on setUpdateStatus.
  if (updateCheckInFlight) {
    return await updateCheckInFlight;
  }
  // A held download ends the real check before it starts, so the fake ends
  // here too — otherwise a second check tears the offer down to `checking`
  // and rebuilds it, which production never does.
  const alreadyOffered = downloadedUpdateMatchesChannel(
    currentUpdateSelectionKey(),
  );
  if (alreadyOffered) {
    return alreadyOffered;
  }
  const version = DEV_FAKE_UPDATE_VERSION;
  log.info("simulating dev update check", { trigger });
  updateCheckInFlight = (async (): Promise<AppUpdateCheckResult> => {
    const stepMs = devFakeUpdateStepMs();
    const canceled = { status: "canceled", version } as const;
    setUpdateStatus({ status: "checking" });
    await devFakeUpdateDelay(stepMs);
    // The fake has no request to abort, so its cancel is the flag alone — but
    // it is registered at the same point and read at the same cadence a real
    // download's is. Registered before `available`, the status that puts the
    // button on screen.
    const download: ActiveUpdateDownload = {
      version,
      cancel: () => {},
      canceled: false,
    };
    activeDownload = download;
    try {
      setUpdateStatus({ status: "available", version });
      await devFakeUpdateDelay(stepMs);
      for (const percent of DEV_FAKE_UPDATE_PERCENT_STEPS) {
        if (download.canceled) {
          setUpdateStatus(canceled);
          return canceled;
        }
        setUpdateStatus({
          status: "downloading",
          version,
          percent,
          transferred: Math.round(
            (DEV_FAKE_UPDATE_TOTAL_BYTES * percent) / 100,
          ),
          total: DEV_FAKE_UPDATE_TOTAL_BYTES,
        });
        await devFakeUpdateDelay(stepMs);
      }
      // Once more after the loop: a cancel pressed during the last step would
      // otherwise be dropped, and the preview would offer a Restart for an
      // update the operator had just declined.
      if (download.canceled) {
        setUpdateStatus(canceled);
        return canceled;
      }
    } finally {
      releaseActiveDownload(download);
      updateCheckInFlight = undefined;
    }
    heldDownloadedUpdate = {
      selection: currentUpdateSelectionKey(),
      version,
    };
    const downloaded = { status: "downloaded", version } as const;
    setUpdateStatus(downloaded);
    return downloaded;
  })();
  return await updateCheckInFlight;
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
    nextStatus.status === "canceled" ||
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
  return withDirection({
    status: "downloaded" as const,
    version: heldDownloadedUpdate.version,
  });
}

function syncAutoInstallOnAppQuit(updateSelection: UpdateSelectionKey): void {
  const eligibleDownload = downloadedUpdateMatchesChannel(updateSelection);
  if (eligibleDownload?.direction === "downgrade") {
    // Moving back down a channel is never something to do behind the
    // operator's back on the next quit. It waits for the explicit restart.
    autoUpdater.autoInstallOnAppQuit = false;
    return;
  }
  autoUpdater.autoInstallOnAppQuit =
    eligibleDownload !== undefined || heldDownloadedUpdate === undefined;
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

type UpdateCheckTrigger = "startup" | "periodic" | "manual" | "menu";

/**
 * Run a check and, when the operator asked for it by name, narrate it.
 *
 * Only the app-menu item reports on `APP_UPDATE_CHECK_RESULT_EVENT_CHANNEL`.
 * Settings answers its own `manual` check inline beside the button, the
 * app-management tool answers the agent that called it, and background polls
 * have nobody waiting — so each of those would be a card raised at someone
 * who did not ask.
 */
export async function checkForAppUpdatesNow(
  trigger: UpdateCheckTrigger = "manual",
): Promise<AppUpdateCheckResult> {
  if (trigger !== "menu") {
    return await runAppUpdateCheck(trigger);
  }
  // The one mid-flight tick on this channel; everything after it is an
  // outcome. It arms the live card, which the status channel then drives.
  emitUpdateCheckResult({ status: "checking" });
  try {
    const result = await runAppUpdateCheck(trigger);
    emitUpdateCheckResult(result);
    return result;
  } catch (err) {
    // `runAppUpdateCheck` answers its own failures, so reaching here means
    // something outside its try threw. An outcome still has to go out: the
    // card is armed and nothing else will ever disarm it, leaving the
    // operator on an indeterminate sweep that cannot end. The menu call site
    // is `void`-ed, so swallowing the throw also keeps it from becoming an
    // unhandled rejection in main.
    const message = err instanceof Error ? err.message : String(err);
    const failed = { status: "error", message } as const;
    log.warn("update check threw outside its own error handling", {
      message,
      trigger,
    });
    setUpdateStatusUnlessDownloaded(failed);
    emitUpdateCheckResult(failed);
    return failed;
  }
}

async function runAppUpdateCheck(
  trigger: UpdateCheckTrigger,
): Promise<AppUpdateCheckResult> {
  if (!productionUpdatesEnabled()) {
    if (devFakeUpdateCheckEnabled()) {
      return await simulateDevUpdateCheck(trigger);
    }
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

  // What the catch below needs to name the slot it failed on, filled in as
  // the check learns each part. It reuses the selection the check already
  // read rather than reading settings a second time — one settings read per
  // check is an invariant the suite asserts.
  let failureContext:
    | {
        channel: DesktopUpdateChannel;
        train: DesktopUpdateTrain;
        tag?: string;
      }
    | undefined;

  updateCheckInFlight = (async () => {
    try {
      const {
        channel: updateChannel,
        train: updateTrain,
      } = currentUpdateSelection();
      failureContext = { channel: updateChannel, train: updateTrain };
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
        trigger === "manual" || trigger === "menu" ? 0 : undefined,
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
      const selectedOrder = compareSemver(selectedVersion, currentVersion);
      // `compareSemver` sorts a tag it cannot parse below every real version,
      // so an unreadable tag looks identical to a deliberate downgrade. The
      // `<= 0` guard this replaced declined both; keep declining the tag we
      // cannot read rather than pointing the update feed at it.
      const selectedIsOlder =
        selectedOrder < 0 && parseSemver(selectedVersion) !== undefined;
      if (selectedOrder <= 0 && !selectedIsOlder) {
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
      // A selection that resolves *older* than the running build means the
      // operator is on a build their own channel no longer serves — the
      // stranding this branch exists to undo. Offer the switch back rather
      // than reporting "up to date" on a version they did not pick.
      if (selectedIsOlder) {
        if (!downgradeOfferAllowed(trigger)) {
          const result = {
            status: "no-update",
            version: currentVersion,
          } as const;
          setUpdateStatusUnlessDownloaded(result);
          log.info("skipping background downgrade offer; selection is older", {
            currentVersion,
            selectedRelease: release.tag_name,
            trigger,
            updateChannel,
            updateTrain,
          });
          return result;
        }
        configureAutoUpdaterChannel(updateChannel, updateTrain, {
          allowDowngrade: true,
        });
        log.info("offering a switch back to the selected channel", {
          currentVersion,
          selectedRelease: release.tag_name,
          trigger,
          updateChannel,
          updateTrain,
        });
      }
      configureAutoUpdaterFeedForRelease(release);
      failureContext = { ...failureContext, tag: release.tag_name };
      updateCheckChannelInFlight = updateSelection;
      // Registered before the call, not after it: `checkForUpdates` emits
      // `update-available` — the status that puts Cancel on screen — from
      // inside itself, and with `autoDownload` on it has already started
      // fetching by the time it resolves.
      const download: ActiveUpdateDownload = {
        version: selectedVersion,
        cancel: () => {},
        canceled: false,
      };
      activeDownload = download;
      let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>;
      try {
        result = await autoUpdater.checkForUpdates();
      } catch (err) {
        releaseActiveDownload(download);
        throw err;
      }
      adoptUpdateDownload(download, result);
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
      return withDirection({
        status: "available" as const,
        version: result.updateInfo.version,
      });
    } catch (err) {
      const result = {
        status: "error",
        message:
          failureContext === undefined
            // Reading the selection itself failed, so there is no slot to
            // name — the generic summary is all the truth there is.
            ? summarizeUpdateError(err)
            : describeUpdateCheckFailure(err, failureContext),
      } as const;
      setUpdateStatusUnlessDownloaded(result);
      // The log keeps the whole error — URL, headers, stack. `result.message`
      // is only what Settings shows, and diagnosing a feed failure from the
      // truncated copy would be worse than having no summary at all.
      log.warn("checkForUpdates failed", {
        message: err instanceof Error ? err.message : String(err),
        reported: result.message,
        trigger,
        updateChannel: failureContext?.channel,
        updateTrain: failureContext?.train,
      });
      return result;
    } finally {
      updateCheckChannelInFlight = undefined;
      updateCheckInFlight = undefined;
    }
  })();

  return updateCheckInFlight;
}

/**
 * Hand the check's cancellation token to the download it belongs to, and
 * watch that download settle.
 *
 * The check itself returns at `available` — PwrAgent reports the download
 * through updater events rather than blocking the check on it — so nothing
 * else ever observes `downloadPromise`. Two things need this handler:
 *
 *  - A rejection nobody reads is an unhandled rejection in main, and cancel
 *    makes one on purpose. electron-updater deliberately does *not* dispatch
 *    its `error` event for a cancellation (it emits `update-cancelled`), so
 *    the rejection would arrive with no handler at all.
 *  - The rejection a cancel produces is byte-identical to a network
 *    failure's. Only our own flag separates "the operator stopped it" from
 *    "the download broke", and dressing the first as a failure would put an
 *    error card in front of someone who got exactly what they asked for.
 */
function adoptUpdateDownload(
  download: ActiveUpdateDownload,
  result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>,
): void {
  if (!result?.downloadPromise) {
    releaseActiveDownload(download);
    return;
  }
  download.version = result.updateInfo?.version ?? download.version;
  const token = result.cancellationToken;
  download.cancel = () => token?.cancel();
  // A cancel that arrived while the token did not yet exist: honor it now
  // rather than letting the download it asked to stop run to completion.
  applyPendingUpdateCancel(download);
  void result.downloadPromise.then(
    () => {
      releaseActiveDownload(download);
    },
    (err: unknown) => {
      releaseActiveDownload(download);
      if (download.canceled) {
        log.info("update download canceled", { version: download.version });
        // Only when electron-updater did not already report it. It emits
        // `update-cancelled` for every abort it recognizes, and settling the
        // same status twice broadcasts a transition that did not happen.
        if (updateStatus.status !== "canceled") {
          setUpdateStatusUnlessDownloaded(
            withDirection({
              status: "canceled" as const,
              version: download.version,
            }),
          );
        }
        return;
      }
      // The `error` event already carried this to the status; the log line is
      // what ties the failure to the version it was fetching.
      log.warn("update download failed", {
        message: err instanceof Error ? err.message : String(err),
        version: download.version,
      });
    },
  );
}

/**
 * Stop the download the update card is reporting.
 *
 * `canceled: false` is the ordinary race, not a fault: the download finished,
 * or never started, while the click was in flight. The card has a status
 * change coming either way, so there is nothing for the caller to do about it.
 */
export function cancelAppUpdateDownload(): AppUpdateCancelResult {
  const download = activeDownload;
  if (!download || download.canceled) {
    return { canceled: false };
  }
  download.canceled = true;
  log.info("canceling update download", { version: download.version });
  // The flag is set first and unconditionally: `cancel` may still be the
  // empty slot an offered-but-not-yet-started download carries, and it may
  // throw (the token is electron-updater's). Either way the download's own
  // rejection must still read as a cancel rather than as a network failure.
  applyPendingUpdateCancel(download);
  return { canceled: true };
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

// Stable Latest is the one slot every Stable operator is pushed onto, so it
// must not depend on a checkbox a human sets by hand. A `main` tag that
// shipped without its GitHub Pre-release flag looks exactly like a stable
// release to `prerelease !== true`; the `-alpha.N` / `-beta.N` /
// `-prerelease.N` suffix in the tag is the part the release process actually
// controls, so a suffix-free tag is what qualifies for the slot.
function isSuffixFreeStableTag(tag: string | undefined): boolean {
  const parsed = parseSemver(tag);
  return parsed !== undefined && parsed.pre.length === 0;
}

function isBetaTrainIdentifier(tag: string | undefined): boolean {
  const id = firstPrereleaseId(tag);
  return id === "alpha" || id === "beta";
}

// Beta slots must never advertise a downgrade from Stable Latest. Historical
// `v1.0.0-beta.N` tags, leftover `v1.1.0-beta.N` after `v1.1.0` is promoted,
// and same-core alphas all lose to the current Latest and stay off the Beta
// train. If there is not yet a GitHub Latest, only an alpha (or a beta that
// has a same-core alpha) counts — a lone `-beta.N` line is the old 1.0 train.
function isBetaTrainRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[],
): boolean {
  if (release.prerelease !== true || !isBetaTrainIdentifier(release.tag_name)) {
    return false;
  }
  if (stableLatest) {
    const releaseParsed = parseSemver(release.tag_name);
    const stableParsed = parseSemver(stableLatest.tag_name);
    return (
      releaseParsed !== undefined
      && stableParsed !== undefined
      && compareSemverCore(releaseParsed.core, stableParsed.core) > 0
    );
  }
  if (firstPrereleaseId(release.tag_name) === "alpha") {
    return true;
  }
  const parsed = parseSemver(release.tag_name);
  if (!parsed) {
    return false;
  }
  return releases.some((candidate) => {
    if (candidate.draft === true || candidate.prerelease !== true) {
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

function isBetaLatestRelease(
  release: GitHubRelease,
  stableLatest: GitHubRelease | undefined,
  releases: GitHubRelease[],
): boolean {
  return (
    firstPrereleaseId(release.tag_name) === "beta"
    && isBetaTrainRelease(release, stableLatest, releases)
  );
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
//   - stable latest      → highest suffix-free GitHub non-prerelease (the 1.0
//                          / normie feed), falling back to the highest GitHub
//                          non-prerelease when no suffix-free tag exists
//   - stable prerelease  → max(stable latest, 1.0 `-prerelease` / legacy `-beta`)
//   - beta latest        → highest `-beta` whose core is ahead of Stable Latest
//   - beta prerelease    → max(beta latest, highest `-alpha` on a newer core)
// Both Beta slots fall back to Stable Latest so installed alphas and betas
// can upgrade to their final release. The saved selection stays on Beta to
// follow the next eligible `main` tag after a Stable promotion.
export function selectChannelReleases(
  releases: GitHubRelease[],
): SelectedUpdateReleases {
  const publicReleases = releases.filter((release) => release.draft !== true);
  const byPrecedenceDesc = [...publicReleases].sort((a, b) =>
    compareSemver(b.tag_name, a.tag_name),
  );
  // Two tiers, not one predicate: a suffix-free stable wins outright, so a
  // mistagged `v1.1.0-alpha.1` cannot take the slot on precedence. The
  // fallback only matters for a release set with no suffix-free tag at all —
  // the pre-`v1.0.0` world, where every stable was a `v1.0.0-beta.N` tag
  // published as GitHub Latest — and preserves the behavior those trains had.
  const stableLatest =
    byPrecedenceDesc.find(
      (release) =>
        release.prerelease !== true && isSuffixFreeStableTag(release.tag_name),
    )
    ?? byPrecedenceDesc.find((release) => release.prerelease !== true);
  const betaLatest = byPrecedenceDesc.find((release) =>
    isBetaLatestRelease(release, stableLatest, publicReleases),
  ) ?? stableLatest;
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
  const betaPrerelease = byPrecedenceDesc.find((release) =>
    isBetaTrainRelease(release, stableLatest, publicReleases),
  ) ?? stableLatest;
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

function githubReleaseHeaders(etag?: string): HeadersInit {
  const token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "PwrAgent",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    // A conditional request that answers 304 is not charged against the
    // GitHub rate limit, so revalidation stays free while nothing ships.
    ...(etag ? { "If-None-Match": etag } : {}),
  };
}

function readResponseHeader(
  response: Response,
  name: string,
): string | undefined {
  return response.headers?.get?.(name) ?? undefined;
}

function rateLimitedError(resetAt: number): Error {
  const resumesAt = new Date(resetAt).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return new Error(`GitHub rate limit reached. Update checks resume at ${resumesAt}.`);
}

/**
 * The reset instant to back off until, or undefined when the failure is not a
 * rate limit. A reset that is not in the future cannot be trusted — a skewed
 * local clock would otherwise leave the backoff permanently disarmed — so it
 * falls back to a fixed window.
 */
function rateLimitResetFromResponse(response: Response): number | undefined {
  const status = response.status;
  const rateLimited =
    (status === 403 || status === 429)
    && readResponseHeader(response, "x-ratelimit-remaining") === "0";
  if (!rateLimited) {
    return undefined;
  }
  const now = Date.now();
  const resetAt =
    Number(readResponseHeader(response, "x-ratelimit-reset")) * 1_000;
  return Number.isFinite(resetAt) && resetAt > now
    ? resetAt
    : now + RATE_LIMIT_FALLBACK_BACKOFF_MS;
}

async function fetchGitHubReleases(): Promise<GitHubRelease[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RELEASE_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(GITHUB_RELEASES_URL, {
      headers: githubReleaseHeaders(releaseCache?.etag),
      signal: controller.signal,
    });
    if (response.status === 304 && releaseCache) {
      releaseCache = { ...releaseCache, fetchedAt: Date.now() };
      rateLimitResetAt = undefined;
      return releaseCache.releases;
    }
    if (!response.ok) {
      const resetAt = rateLimitResetFromResponse(response);
      if (resetAt === undefined) {
        throw new Error(
          `GitHub releases request failed with ${response.status}`,
        );
      }
      rateLimitResetAt = resetAt;
      log.warn("GitHub release rate limit reached", {
        resetAt: new Date(resetAt).toISOString(),
        status: response.status,
      });
      throw rateLimitedError(resetAt);
    }
    const payload = await response.json();
    const releases = Array.isArray(payload)
      ? payload.filter((release): release is GitHubRelease =>
          typeof release === "object" && release !== null,
        )
      : [];
    releaseCache = {
      etag: readResponseHeader(response, "etag"),
      fetchedAt: Date.now(),
      releases,
    };
    rateLimitResetAt = undefined;
    return releases;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Single owner of the GitHub release list. Every caller in main goes through
 * this cache, and the renderer only ever reads it over IPC, so a Settings
 * mount costs no network request.
 */
async function readGitHubReleases(
  maxAgeMs = APP_UPDATE_RELEASE_CACHE_TTL_MS,
): Promise<GitHubRelease[]> {
  const now = Date.now();
  const cacheAgeMs = releaseCache ? now - releaseCache.fetchedAt : undefined;
  // A negative age means the wall clock moved backwards. Treat that entry as
  // stale rather than fresh for the size of the jump.
  if (
    releaseCache
    && cacheAgeMs !== undefined
    && cacheAgeMs >= 0
    && cacheAgeMs < maxAgeMs
  ) {
    return releaseCache.releases;
  }
  if (rateLimitResetAt !== undefined && now < rateLimitResetAt) {
    // Spending a request that GitHub will reject only deepens the hole. Serve
    // the last good list when we have one.
    if (releaseCache) {
      return releaseCache.releases;
    }
    throw rateLimitedError(rateLimitResetAt);
  }
  if (!releaseFetchInFlight) {
    releaseFetchInFlight = fetchGitHubReleases().finally(() => {
      releaseFetchInFlight = undefined;
    });
  }
  try {
    return await releaseFetchInFlight;
  } catch (err) {
    // The request that discovers the limit degrades the same way every later
    // one does: last good list first, error only when there is none.
    if (
      releaseCache
      && rateLimitResetAt !== undefined
      && Date.now() < rateLimitResetAt
    ) {
      return releaseCache.releases;
    }
    throw err;
  }
}

async function readAppUpdateReleaseForChannel(
  updateChannel: DesktopUpdateChannel,
  updateTrain: DesktopUpdateTrain,
  maxAgeMs?: number,
): Promise<GitHubRelease | undefined> {
  const releases = await readGitHubReleases(maxAgeMs);
  return releaseForSelection(
    selectAppUpdateReleases(releases),
    updateChannel,
    updateTrain,
  );
}

export async function readAppUpdateReleaseVersions(): Promise<AppUpdateReleaseVersions> {
  if (e2eUpdateChecksDisabled()) {
    const unavailable = { unavailableReason: "Update checks are disabled." };
    return {
      fetchedAt: Date.now(),
      stable: { latest: unavailable, prerelease: unavailable },
      beta: { latest: unavailable, prerelease: unavailable },
    };
  }
  try {
    const releases = await readGitHubReleases();
    const selected = selectAppUpdateReleases(releases);
    return {
      fetchedAt: releaseCache?.fetchedAt ?? Date.now(),
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
    // Rendered inside a release slot tile, which has room for a sentence —
    // so the log has to keep the rest. Without this the summary destroys the
    // only copy of a long GitHub error instead of relocating it, which the
    // other two `summarizeUpdateError` call sites are careful not to do.
    log.warn("failed to read app update release versions", {
      message: err instanceof Error ? err.message : String(err),
    });
    const unavailable = { unavailableReason: summarizeUpdateError(err) };
    return {
      fetchedAt: Date.now(),
      stable: { latest: unavailable, prerelease: unavailable },
      beta: { latest: unavailable, prerelease: unavailable },
    };
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
    getDesktopConfigStore().subscribe(["updates"], () => {
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
    setUpdateStatus(
      withDirection({ status: "available" as const, version: info.version }),
    );
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
    // `update-available` has already put the manifest's own version on the
    // status by the time bytes move, and that is the version
    // `update-downloaded` will offer. `activeDownload.version` is only the
    // fallback because it starts life as the GitHub tag, which a release can
    // spell differently from its manifest.
    const version =
      updateStatus.status === "available"
      || updateStatus.status === "downloading"
        ? updateStatus.version
        : activeDownload?.version ?? "unknown";
    // The bytes come along for the card's meter, not just the log: a percent
    // alone cannot tell a 4 MB delta apart from a 120 MB full download, and
    // on a slow link that is the whole question of whether waiting is worth
    // it.
    setUpdateStatus(
      withDirection({
        status: "downloading" as const,
        version,
        percent: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      }),
    );
  });
  // electron-updater reports its own aborts here and, deliberately, not
  // through `error`. Settling on `canceled` rather than back on `available`
  // keeps Settings from promising a download that is no longer running.
  autoUpdater.on("update-cancelled", (info) => {
    const version = info?.version ?? activeDownload?.version ?? "unknown";
    log.info("update-cancelled", { version });
    if (info?.version) {
      pendingDownloadChannelsByVersion.delete(info.version);
    }
    setUpdateStatusUnlessDownloaded(
      withDirection({ status: "canceled" as const, version }),
    );
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
    // Same multi-kilobyte shape as a failed check — this handler is where a
    // download failure arrives, and it reaches the same Settings row.
    log.warn("auto-update error", { message: err.message });
    setUpdateStatusUnlessDownloaded({
      status: "error",
      message: summarizeUpdateError(err),
    });
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
  // Nothing was downloaded: this offer is the dev/QA fake, and there is no
  // payload for Squirrel to apply. Say so rather than quitting the app the
  // operator is previewing in. Keyed on the fake's own version rather than on
  // the build type, so a dev or E2E path that ever holds a real download is
  // not refused with a reason that does not apply to it.
  if (version === DEV_FAKE_UPDATE_VERSION && !productionUpdatesEnabled()) {
    log.info("declining to install the dev fake update", { version });
    return {
      status: "error",
      message: "This is the dev preview update. Nothing was downloaded to install.",
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
  ipcMain.removeHandler(APP_UPDATE_CANCEL_DOWNLOAD_CHANNEL);
  ipcMain.handle(
    APP_UPDATE_CANCEL_DOWNLOAD_CHANNEL,
    async (): Promise<AppUpdateCancelResult> => cancelAppUpdateDownload(),
  );
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
  ipcMain.removeHandler(APP_UPDATE_CANCEL_DOWNLOAD_CHANNEL);
}
