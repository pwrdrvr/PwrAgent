import { app, BrowserWindow, ipcMain } from "electron";
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
  AppUpdateDirection,
  AppUpdateInstallResult,
  AppUpdateReleaseInfo,
  AppUpdateReleaseVersions,
  AppUpdateStatus,
} from "../shared/app-metadata";
import {
  DESKTOP_UPDATE_CHANNEL_DEFAULT,
  DESKTOP_UPDATE_TRAIN_DEFAULT,
  inferDesktopUpdateSelection,
  type DesktopUpdateChannel,
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

function currentUpdateSelection(): {
  channel: DesktopUpdateChannel;
  train: DesktopUpdateTrain;
} {
  const updates = getDesktopConfigStore().read("updates");
  if (updates.channel === undefined && updates.train === undefined) {
    return inferDesktopUpdateSelection(app.getVersion());
  }
  return {
    channel: updates.channel ?? DESKTOP_UPDATE_CHANNEL_DEFAULT,
    train: updates.train ?? DESKTOP_UPDATE_TRAIN_DEFAULT,
  };
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
  const raw = err instanceof Error ? err.message : String(err);
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

export async function checkForAppUpdatesNow(
  trigger: UpdateCheckTrigger = "manual",
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
// Empty Beta slots stay empty. The Settings Beta control remains selectable
// so an operator can follow the next `main` tag after a Stable promotion.
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
  const betaPrerelease = byPrecedenceDesc.find((release) =>
    isBetaTrainRelease(release, stableLatest, publicReleases),
  );
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
    // Rendered inside a release slot tile, which has room for a sentence.
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
    const version =
      updateStatus.status === "available" || updateStatus.status === "downloading"
        ? updateStatus.version
        : "unknown";
    setUpdateStatus(
      withDirection({
        status: "downloading" as const,
        version,
        percent: Math.round(progress.percent),
      }),
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
