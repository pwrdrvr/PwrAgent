export type AppMetadata = {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  homepage: string;
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
  | { status: "available"; version: string };
