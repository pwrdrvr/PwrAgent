export type MattermostAuthorizedContact = {
  id: string;
  displayName: string;
};

export type MattermostMessagingConfig = {
  authorizedActorIds: MattermostAuthorizedContact[];
  /**
   * Bot access token from Mattermost (System Console → Integrations → Bot Accounts).
   * Personal access tokens also work but a bot account is the canonical identity.
   */
  botToken: string;
  /**
   * Public URL Mattermost will POST to when a user clicks an interactive
   * button. Mattermost embeds this verbatim in each action's
   * `integration.url`. Production deployments front this with a tunnel
   * (Cloudflare Tunnel / Tailscale Funnel / ngrok) that terminates TLS
   * and forwards to localhost.
   *
   * The local bind port is derived from this URL: if the URL has an
   * explicit port (`http://localhost:47821/`, `http://host.docker.internal:47821/`),
   * the listener binds there; otherwise the listener binds to a default
   * port (47821) and the tunnel forwards to that. There is no separate
   * port field — having two sources of truth invites them to disagree.
   *
   * Path is up to you (e.g., `/messaging/mattermost/callback`); the
   * listener accepts any POST.
   */
  callbackBaseUrl: string;
  /**
   * Optional: override the HMAC secret used to sign each rendered button's
   * `integration.context`. Defaults to a fresh random secret per adapter
   * start, which is the recommended setting (regenerating on restart acts
   * as automatic TTL for outstanding callback URLs). Override only for
   * deterministic test runs.
   */
  callbackHmacSecret?: string;
  channel: "mattermost";
  enabled?: boolean;
  /**
   * Mattermost server URL, e.g. `https://chat.example.com`. Both REST
   * (`Client4`) and WebSocket (`/api/v4/websocket`) endpoints derive from
   * this base.
   */
  serverUrl: string;
  /**
   * Optional: prefix prepended to every registered slash command's
   * trigger so we don't collide with built-in Mattermost commands
   * (`/status`, `/away`, `/leave`, etc.). With the default
   * `pwragent_`, we register `/pwragent_resume`, `/pwragent_status`,
   * `/pwragent_detach`. Set to an empty string to register bare
   * triggers (`/resume`, `/status`, `/detach`) — the operator
   * accepts collision risk in exchange for shorter invocations.
   *
   * Constraints (Mattermost server-enforced): the full trigger
   * (prefix + base) must match `^[A-Za-z0-9_./-]+$` and be 1–128
   * chars. Invalid prefixes are rejected at startup with a warning
   * and the default is used.
   */
  slashCommandPrefix?: string;
  /**
   * Whether to register Mattermost slash commands (`/pwragent_help`,
   * `/pwragent_status`, etc.) with the server on adapter start.
   *
   * Default: `false`. Mattermost 10.x slash-command bodies omit
   * `root_id`, so a slash response can't be threaded — it lands in the
   * channel. The `@<bot>` text-mention path works on every version
   * and preserves thread context, so it is the recommended primary
   * entry point. Operators who accept the v10.x channel-reply tradeoff
   * can opt in by setting this true (and on Mattermost 11.0+ slash
   * commands DO include `root_id`, so threading works).
   */
  registerSlashCommands?: boolean;
  streamingResponses?: boolean;
};
