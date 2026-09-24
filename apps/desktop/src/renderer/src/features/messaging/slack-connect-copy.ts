export const SLACK_EVENTS_API_UNIMPLEMENTED_NOTICE =
  "Events API is not implemented. PwrAgent will use Socket Mode.";

export const SLACK_ADMIN_APPROVAL_COPY =
  "If Slack says only owners can install apps in your workspace, copy the link for an admin, or ask them to approve your request. PwrAgent never needs their Slack password.";

/**
 * The onboarding card's condensed version of `SlackCredentialSteps`. The old
 * list said "Install to Workspace" and "Basic Information → App-Level Tokens"
 * and left out the rest: that the bot token only appears on Install App after
 * installing, and that the app-level token needs exactly one scope, picked in
 * a dialog.
 */
export const SLACK_CONNECT_CHECKLIST = [
  "In the new app’s sidebar, open Install App, click Install to Workspace, then Allow.",
  "Under OAuth Tokens, copy the Bot User OAuth Token (xoxb-) and paste it below.",
  "Open Basic Information → App-Level Tokens, click Generate Token and Scopes, add only the connections:write scope, and paste the xapp- token below.",
  "On Basic Information → App Credentials, copy the Signing Secret and paste it below.",
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
