export const SLACK_EVENTS_API_UNIMPLEMENTED_NOTICE =
  "Events API is not implemented. PwrAgent will use Socket Mode.";

export const SLACK_ADMIN_APPROVAL_COPY =
  "This workspace only allows owners to install unpublished apps. Copy the link for an admin, or ask them to approve your request. PwrAgent never needs their Slack password.";

export const SLACK_CONNECT_CHECKLIST = [
  "In the new app, click Install to Workspace and Allow.",
  "Copy the Bot User OAuth Token (it starts with xoxb-) and paste it below.",
  "Under Basic Information → App-Level Tokens, generate a token with connections:write and paste the xapp- token below.",
] as const;

/**
 * What to do in Slack once the manifest is on the clipboard. These were a
 * single run-on sentence in the copy-and-open status line; a manifest
 * update is a multi-stop trip through Slack's UI, so it gets the same
 * numbered treatment the create path already had.
 *
 * No reinstall step: v2 adds two bot events (`agent_session_stopped`,
 * `agent_session_title_changed`) and no scopes, so Slack does not force a
 * reinstall. Add one here if a future manifest changes `oauth_config`.
 */
export const SLACK_MANIFEST_UPDATE_STEPS = [
  "In Slack, choose your existing PwrAgent app.",
  "Open App Manifest.",
  "Select all, paste the copied manifest, and save changes.",
] as const;

export const SLACK_MANIFEST_BLURB =
  "PwrAgent's manifest changes as the integration gains features. Copy the current one to bring your existing app up to date.";
