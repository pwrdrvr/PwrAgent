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

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "downloaded"; version: string }
  | { status: "available"; version: string };

export type AppUpdateStatus =
  | { status: "idle" }
  | { status: "skipped"; reason: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string }
  | { status: "downloading"; version: string; percent?: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

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

export type AppUpdateReleaseVersions = {
  latest: AppUpdateReleaseInfo;
  prerelease: AppUpdateReleaseInfo;
  fetchedAt: number;
};
