export const PWRAGENT_HOMEPAGE_URL = "https://pwragent.ai";
export const PWRAGENT_DOCUMENTATION_URL = "https://docs.pwragent.ai";

export type AppMetadata = {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  homepage: string;
  documentationUrl: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
  /**
   * OS process ids, so an operator running several Electron apps (or several
   * dev builds) can tell a profiler, `lldb`, or a bug report exactly which
   * process to attach to. `rendererProcessId` is the window that asked.
   */
  mainProcessId: number;
  rendererProcessId?: number;
  /** Active PwrAgent profile and its corresponding local support paths. */
  activeProfileName: string;
  logFilePath?: string;
  codexProfilePath?: string;
};

export type AppLicenseDocumentKind = "license" | "third-party-licenses";

export type AppLicenseDocument = {
  kind: AppLicenseDocumentKind;
  title: string;
  content: string;
};

export type AppChangelogDocument = {
  kind: "changelog";
  title: string;
  content: string;
};

export type AppLogSnapshot = {
  kind: "log-snapshot";
  title: string;
  logFilePath?: string;
  debugCollectionEnabled: boolean;
  entries: AppLogEntry[];
  readAt: number;
  truncated: boolean;
  unavailableReason?: string;
};

export type AppLogEntry = {
  sequence: number;
  timestamp: number;
  level: string;
  scope?: string;
  line: string;
};

/**
 * Direction of an offered build relative to the running one. `"downgrade"`
 * means the release resolved for the operator's own channel/track selection
 * is *older* than what is running — a deliberate switch back onto the chosen
 * channel, not an update. Absent means the normal forward case; a surface
 * that ignores the field keeps its existing "update" wording.
 */
export type AppUpdateDirection = "downgrade";

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "downloaded"; version: string; direction?: AppUpdateDirection }
  | { status: "available"; version: string; direction?: AppUpdateDirection }
  | { status: "canceled"; version: string; direction?: AppUpdateDirection };

/**
 * Bytes moved so far on the update payload. Optional throughout: a provider
 * that reports no content length gives electron-updater a percent and nothing
 * else, and the meter has to degrade to that rather than print `NaN MB`.
 *
 * A percent alone cannot tell a 4 MB delta apart from a 120 MB full download,
 * and on a slow link that is the whole question of whether waiting is worth
 * it — which is why these ride along instead of staying in the log.
 */
export type AppUpdateDownloadProgress = {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

export type AppUpdateStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string; direction?: AppUpdateDirection }
  | ({
      status: "downloading";
      version: string;
      direction?: AppUpdateDirection;
    } & AppUpdateDownloadProgress)
  | { status: "downloaded"; version: string; direction?: AppUpdateDirection }
  /**
   * The operator stopped the download. The release is still published, so
   * this is not `available` (which promises a download is under way) and not
   * an `error` (nothing failed) — it stands until the next check.
   */
  | { status: "canceled"; version: string; direction?: AppUpdateDirection }
  | { status: "error"; message: string };

/**
 * Whether a download was actually running to stop. `false` is the ordinary
 * race — the download finished, or never started, while the click was in
 * flight — not a fault.
 */
export type AppUpdateCancelResult = { canceled: boolean };

export type AppUpdateInstallResult =
  | { status: "restarting" }
  | { status: "error"; message: string };

export type AppUpdateReleaseInfo = {
  version?: string;
  name?: string;
  url?: string;
  publishedAt?: string;
  unavailableReason?: string;
};

export type AppUpdateReleaseSlotVersions = {
  latest: AppUpdateReleaseInfo;
  prerelease: AppUpdateReleaseInfo;
};

export type AppUpdateReleaseVersions = {
  stable: AppUpdateReleaseSlotVersions;
  beta: AppUpdateReleaseSlotVersions;
  fetchedAt: number;
};
