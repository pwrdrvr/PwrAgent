export type AppMetadata = {
  applicationName: string;
  applicationVersion: string;
  copyright: string;
  homepage: string;
  electronVersion: string;
  chromeVersion: string;
  nodeVersion: string;
};

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string };
