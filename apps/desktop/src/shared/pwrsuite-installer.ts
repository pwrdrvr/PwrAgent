// What the New Thread launchpad's PwrSuite tiles know about downloading a
// sister app's installer. The main process owns the download, so it survives
// the launchpad unmounting; every window reads the current state on mount and
// follows the events after it.

export type PwrSuiteAppId = "pwrgit" | "pwrsnap";

/** The installer this machine gets. There is no Linux release of either app. */
export type PwrSuiteInstallerPlatform = "mac" | "windows";

/** The release asset picked for this machine, read from GitHub. */
export type PwrSuiteInstallerOffer = {
  platform: PwrSuiteInstallerPlatform;
  version: string;
  assetName: string;
  sizeBytes: number;
};

/**
 * `idle` is also the state after a cancel: the partial file is gone and the
 * tile offers the download again.
 */
export type PwrSuiteInstallerPhase =
  | "idle"
  | "downloading"
  | "verifying"
  | "ready"
  | "failed";

export type PwrSuiteInstallerState = {
  app: PwrSuiteAppId;
  /** Absent where neither app ships an installer (Linux). */
  platform?: PwrSuiteInstallerPlatform;
  phase: PwrSuiteInstallerPhase;
  /** Absent until GitHub answers, and after a read that failed. */
  offer?: PwrSuiteInstallerOffer;
  receivedBytes?: number;
  totalBytes?: number;
  bytesPerSecond?: number;
  /** The downloaded installer's file name, once it is verified. */
  fileName?: string;
  /** A short, operator-facing reason. The full error goes to the log. */
  error?: string;
};

/** What Open installer and Show in Finder answer. */
export type PwrSuiteInstallerActionResult = { opened: boolean; error?: string };

export const PWRSUITE_PRODUCT_URLS: Record<PwrSuiteAppId, string> = {
  pwrgit: "https://pwrgit.com",
  pwrsnap: "https://pwrsnap.com",
};
