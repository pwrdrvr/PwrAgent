export type MattermostMessagingConfig = {
  authorizedActorIds: string[];
  /**
   * Bot access token from Mattermost (System Console → Integrations → Bot Accounts).
   * Personal access tokens also work but a bot account is the canonical identity.
   */
  botToken: string;
  /**
   * Public URL Mattermost will POST to when a user clicks an interactive
   * button. Mattermost embeds this in the action's `integration.url`. The
   * adapter binds an HTTP listener to `127.0.0.1:callbackPort`; production
   * deployments expose this via Cloudflare Tunnel / Tailscale Funnel / ngrok
   * which terminates TLS and forwards to localhost.
   *
   * Path is up to you (e.g., `/messaging/mattermost/callback`); the listener
   * accepts any POST under the configured port.
   */
  callbackBaseUrl: string;
  /**
   * Optional: override the localhost port the HTTP listener binds to.
   * Defaults to 47821 (a randomly chosen unused port — change if it
   * conflicts with something else on the host).
   */
  callbackPort?: number;
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
  streamingResponses?: boolean;
};
