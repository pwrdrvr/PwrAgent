export const SLACK_EVENTS_API_UNIMPLEMENTED_NOTICE =
  "Events API is not implemented. PwrAgent will use Socket Mode.";

export const SLACK_ADMIN_APPROVAL_COPY =
  "This workspace only allows owners to install unpublished apps. Send them the Create Slack app link, or ask them to approve your request. PwrAgent never needs their Slack password.";

export const SLACK_CONNECT_CHECKLIST = [
  "In the new app, click Install to Workspace and Allow.",
  "Copy the Bot User OAuth Token (it starts with xoxb-) and paste it below.",
  "Under Basic Information → App-Level Tokens, generate a token with connections:write and paste the xapp- token below.",
] as const;
