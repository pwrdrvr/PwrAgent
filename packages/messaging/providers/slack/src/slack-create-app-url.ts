import {
  buildOfficialSlackAppManifest,
  slackAppManifestJson,
  type SlackAppManifest,
} from "./slack-app-manifest.ts";

export const SLACK_CREATE_APP_URL_BASE = "https://api.slack.com/apps?new_app=1";

/** Slack's list of the operator's apps. */
export const SLACK_APP_MANAGEMENT_URL = "https://api.slack.com/apps";

/**
 * Conservative query-string budget for Slack's create-from-manifest URL.
 * Some browsers and intermediaries still choke near 8 KiB. A future
 * catalog expansion that blows this budget falls back to the bare
 * create-app page plus the raw JSON for paste.
 */
export const SLACK_CREATE_APP_URL_MAX_LENGTH = 8_000;

export type SlackCreateAppUrl = {
  /** URL the desktop should open. Bare `new_app=1` when oversized. */
  url: string;
  /** Full create-from-manifest URL, even when longer than the budget. */
  fullUrl: string;
  oversized: boolean;
  manifestJson: string;
};

export type BuildSlackCreateAppUrlOptions = {
  manifest?: SlackAppManifest;
  maxLength?: number;
};

export function buildSlackCreateAppUrl(
  options: BuildSlackCreateAppUrlOptions = {},
): SlackCreateAppUrl {
  const manifest = options.manifest ?? buildOfficialSlackAppManifest();
  const compactManifestJson = JSON.stringify(manifest);
  const manifestJson = slackAppManifestJson(manifest);
  const fullUrl =
    `${SLACK_CREATE_APP_URL_BASE}&manifest_json=${encodeURIComponent(compactManifestJson)}`;
  const maxLength = options.maxLength ?? SLACK_CREATE_APP_URL_MAX_LENGTH;
  const oversized = fullUrl.length > maxLength;
  return {
    url: oversized ? SLACK_CREATE_APP_URL_BASE : fullUrl,
    fullUrl,
    oversized,
    manifestJson,
  };
}

/**
 * An app-level token names its app: `xapp-1-A0123ABCDEF-<n>-<secret>`. That is
 * the only place the desktop learns the app ID without another scope, and it
 * is what lets Settings open this app's own pages instead of the app list.
 */
export function slackAppIdFromAppToken(appToken: string | undefined): string | undefined {
  const match = /^xapp-\d+-(A[A-Z0-9]{6,20})-/u.exec(appToken?.trim() ?? "");
  return match?.[1];
}

/**
 * The app's Basic Information page (App Credentials, App-Level Tokens,
 * Display Information), or Slack's app list when no app-level token names
 * the app yet.
 */
export function buildSlackAppSettingsUrl(appToken: string | undefined): {
  url: string;
  appSpecific: boolean;
} {
  const appId = slackAppIdFromAppToken(appToken);
  return appId
    ? { url: `${SLACK_APP_MANAGEMENT_URL}/${appId}/general`, appSpecific: true }
    : { url: SLACK_APP_MANAGEMENT_URL, appSpecific: false };
}
