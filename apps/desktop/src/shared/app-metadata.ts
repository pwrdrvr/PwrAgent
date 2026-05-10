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

export type AppUpdateCheckResult =
  | { status: "skipped"; reason: string }
  | { status: "error"; message: string }
  | { status: "checking" }
  | { status: "no-update"; version: string }
  | { status: "available"; version: string };
