import {
  buildOfficialSlackAppManifest,
  type SlackAppManifest,
} from "./slack-app-manifest.ts";

export const SLACK_CREATE_APP_URL_BASE = "https://api.slack.com/apps?new_app=1";

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
  const manifestJson = JSON.stringify(manifest);
  const fullUrl =
    `${SLACK_CREATE_APP_URL_BASE}&manifest_json=${encodeURIComponent(manifestJson)}`;
  const maxLength = options.maxLength ?? SLACK_CREATE_APP_URL_MAX_LENGTH;
  const oversized = fullUrl.length > maxLength;
  return {
    url: oversized ? SLACK_CREATE_APP_URL_BASE : fullUrl,
    fullUrl,
    oversized,
    manifestJson,
  };
}
