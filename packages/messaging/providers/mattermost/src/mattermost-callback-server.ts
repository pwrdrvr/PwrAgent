import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/**
 * Localhost-bound HTTP listener that receives Mattermost interactive
 * button POSTs and dispatches them to the adapter as inbound callback
 * events.
 *
 * Mattermost (unlike Telegram and Discord) delivers button clicks
 * out-of-band: the click does NOT come back over the WebSocket the bot
 * is already listening to. Instead, Mattermost POSTs to the URL the bot
 * embedded in the action's `integration.url`. We host that URL here.
 *
 * Production deployments expose this listener via Cloudflare Tunnel /
 * Tailscale Funnel / ngrok, all of which terminate TLS upstream and
 * forward to localhost. The listener never binds to a public interface.
 */

/**
 * Mattermost POST body when a user clicks an interactive button. The
 * server-side schema is documented at
 * https://developers.mattermost.com/integrate/plugins/interactive-messages/
 *
 * `context` is the same JSON object the bot supplied when it rendered
 * the button — for us, an opaque handle plus an HMAC and routing
 * metadata that we use to reverse-look-up the semantic action.
 */
export type MattermostInteractiveCallbackBody = {
  user_id: string;
  user_name?: string;
  channel_id: string;
  channel_name?: string;
  team_id?: string;
  team_domain?: string;
  post_id?: string;
  trigger_id?: string;
  type?: string;
  data_source?: string;
  context?: Record<string, unknown>;
};

/**
 * Result a `MattermostCallbackHandler` may return to influence the HTTP
 * response Mattermost receives. The body shape is the standard
 * Mattermost integration response: `{ update?: Post, ephemeral_text? }`.
 *
 * Today we only ever set `update.props.attachments = []` to clear the
 * clicked-on buttons inline, but the type stays open so future callers
 * (e.g., per-callback ephemeral acknowledgments) can extend it without
 * a signature change.
 */
export type MattermostCallbackHandlerResult = {
  clearAttachments?: boolean;
  ephemeralText?: string;
};

export type MattermostCallbackHandler = (
  body: MattermostInteractiveCallbackBody,
  rawBody: string,
) => Promise<MattermostCallbackHandlerResult | void> | MattermostCallbackHandlerResult | void;

/**
 * Slash-command POST body, form-decoded. Mattermost sends commands as
 * `application/x-www-form-urlencoded`; the listener routes them here
 * after parsing. The `token` field is the per-command token issued by
 * Mattermost at registration time — verified by string-equal against
 * the cached value before the handler is called.
 *
 * See <https://developers.mattermost.com/integrate/slash-commands/custom/>
 * for the body field documentation.
 */
export type MattermostSlashCommandBody = {
  token: string;
  team_id: string;
  team_domain?: string;
  channel_id: string;
  channel_name?: string;
  user_id: string;
  user_name?: string;
  /** The full command, e.g. `/pwragent_resume` (with leading slash). */
  command: string;
  /** Args after the trigger, e.g. `--projects`. */
  text: string;
  trigger_id?: string;
  response_url?: string;
  /**
   * Set when the command was invoked from inside a thread reply —
   * the root post id of that thread. Mattermost added this field in
   * v6.1.0 (Nov 2021); older servers will omit it. We use it to
   * route the bot's response back into the same thread instead of
   * the parent channel.
   */
  root_id?: string;
};

/**
 * Result a slash-command handler may return. Same response envelope as
 * interactive callbacks (`update` for post mutation, `ephemeral_text`
 * for a one-off message visible only to the invoker).
 *
 * Slash commands additionally support `response_type` to control
 * whether the bot's reply is in-channel or ephemeral; we don't surface
 * that today (the controller renders its own surfaces via the normal
 * intent flow).
 */
export type MattermostSlashCommandResult = {
  ephemeralText?: string;
};

export type MattermostSlashCommandHandler = (
  body: MattermostSlashCommandBody,
  rawBody: string,
) => Promise<MattermostSlashCommandResult | void> | MattermostSlashCommandResult | void;

export type MattermostCallbackServerConfig = {
  /**
   * Localhost port to bind. Production deployments terminate TLS at the
   * tunnel ingress and forward to this port.
   */
  port: number;
  /**
   * HMAC secret used to verify the per-button `context.hmac` signature.
   * Defaults to a fresh random secret per adapter start (regenerating on
   * restart acts as automatic TTL for outstanding callback URLs).
   */
  hmacSecret: string;
  handler: MattermostCallbackHandler;
  /**
   * Optional slash-command handler. When set, POSTs whose Content-Type
   * is `application/x-www-form-urlencoded` are routed here after the
   * `token` field is verified against `validSlashCommandTokens`. When
   * unset (or no command tokens are registered), command POSTs are
   * silently ack'd with a 200 — same hardening posture as a bad-HMAC
   * interactive callback.
   */
  slashCommandHandler?: MattermostSlashCommandHandler;
  /**
   * Set of currently-valid command tokens. The adapter populates this
   * from the reconciler's per-team token map; updated on adapter start
   * and on subsequent reconcile passes.
   */
  validSlashCommandTokens?: Set<string>;
  logger: {
    debug?: (msg: string, data?: Record<string, unknown>) => void;
    info?: (msg: string, data?: Record<string, unknown>) => void;
    warn: (msg: string, data?: Record<string, unknown>) => void;
    error: (msg: string, data?: Record<string, unknown>) => void;
  };
};

export type MattermostCallbackServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * Sign a `context` payload before embedding in an interactive button's
   * `integration.context`. The HMAC field is verified at click time —
   * tampering rejects with no information leak.
   */
  signContext(payload: { intentId: string; actionId: string }): {
    hmac: string;
    issuedAt: number;
  };
};

/**
 * Generate a fresh per-process HMAC secret. Regenerated on every adapter
 * start; outstanding callback URLs created before a restart fail
 * verification — this is the desired TTL behavior.
 */
export function generateMattermostHmacSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compute the HMAC for a given (intentId, actionId, issuedAt) tuple.
 * Exposed so the adapter can compute the value at render time matching
 * what the server expects at verify time.
 */
export function computeMattermostContextHmac(params: {
  hmacSecret: string;
  intentId: string;
  actionId: string;
  issuedAt: number;
}): string {
  const mac = createHmac("sha256", params.hmacSecret);
  mac.update(`${params.intentId}|${params.actionId}|${params.issuedAt}`);
  return mac.digest("hex");
}

/**
 * Create a localhost HTTP listener for Mattermost interactive callbacks.
 *
 * The listener:
 * - Binds to `127.0.0.1:port` only (no public interface).
 * - Accepts only `POST` to any path (Mattermost includes the URL it
 *   was given verbatim, so we don't pin a specific path).
 * - Verifies HMAC on `context.hmac` against `(intentId|actionId|issuedAt)`.
 * - Always responds `200` with `{"update": null}` to avoid leaking
 *   verification status. Verification failures are logged.
 * - Hands valid callbacks to the supplied handler. The handler is
 *   responsible for resolving the opaque handle into a semantic action
 *   and dispatching to the controller.
 */
export function createMattermostCallbackServer(
  config: MattermostCallbackServerConfig,
): MattermostCallbackServer {
  let server: Server | undefined;

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    const respondInteractiveAck = (
      result?: MattermostCallbackHandlerResult,
    ): void => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      const payload: Record<string, unknown> = {};
      if (result?.clearAttachments) {
        // Mattermost applies this `update` to the post BEFORE returning
        // control to the user's client — the buttons disappear in the
        // same render cycle as the click. The post's main `message`
        // text is preserved (we only nuke `props.attachments`); since
        // our adapter never puts informational text inside attachments
        // (only actions), this is a safe blanket clear.
        payload.update = { props: { attachments: [] } };
      } else {
        payload.update = null;
      }
      if (result?.ephemeralText) {
        payload.ephemeral_text = result.ephemeralText;
      }
      response.end(JSON.stringify(payload));
    };

    const respondCommandAck = (
      result?: MattermostSlashCommandResult,
    ): void => {
      response.statusCode = 200;
      response.setHeader("Content-Type", "application/json");
      const payload: Record<string, unknown> = {};
      if (result?.ephemeralText) {
        payload.text = result.ephemeralText;
        // Mattermost's command response shape: `response_type: "ephemeral"`
        // shows the text only to the invoker. The default
        // (`in_channel`) would be visible to everyone in the channel.
        payload.response_type = "ephemeral";
      }
      response.end(JSON.stringify(payload));
    };

    if (request.method !== "POST") {
      response.statusCode = 405;
      response.setHeader("Allow", "POST");
      response.end();
      return;
    }

    let rawBody = "";
    try {
      for await (const chunk of request) {
        rawBody += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        if (rawBody.length > 1_000_000) {
          // Mattermost's MaximumPayloadSizeBytes default is 300 KB.
          // 1 MB is a generous absolute upper bound that protects the
          // listener from accidental abuse without rejecting legitimate
          // attachment-heavy posts.
          config.logger.warn("mattermost callback body exceeded 1 MB; dropping", {});
          respondInteractiveAck();
          return;
        }
      }
    } catch (error) {
      config.logger.error("mattermost callback body read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      respondInteractiveAck();
      return;
    }

    // Route by Content-Type:
    //   application/x-www-form-urlencoded → slash command
    //   anything else (default JSON)      → interactive callback
    //
    // Both surfaces share the listener / port / tunnel — Mattermost
    // sends commands as form-encoded bodies and interactive callbacks
    // as JSON, so the type alone is enough to disambiguate. Same path
    // works for both, which matters because the operator's tunnel may
    // map the public URL to ANY localhost path.
    const contentType = (request.headers["content-type"] ?? "").toLowerCase();
    const isFormEncoded = contentType.includes("application/x-www-form-urlencoded");

    if (isFormEncoded) {
      await handleSlashCommand({
        rawBody,
        config,
        respond: respondCommandAck,
      });
      return;
    }

    let body: MattermostInteractiveCallbackBody;
    try {
      body = JSON.parse(rawBody) as MattermostInteractiveCallbackBody;
    } catch (error) {
      config.logger.warn("mattermost callback body not JSON; dropping", {
        error: error instanceof Error ? error.message : String(error),
        bytes: rawBody.length,
      });
      respondInteractiveAck();
      return;
    }

    const context = body.context ?? {};
    const intentId = stringField(context["intentId"]);
    const actionId = stringField(context["actionId"]);
    const issuedAtRaw = numberField(context["issuedAt"]);
    const providedHmac = stringField(context["hmac"]);

    if (!intentId || !actionId || issuedAtRaw === undefined || !providedHmac) {
      config.logger.warn("mattermost callback context missing required fields", {
        hasIntentId: Boolean(intentId),
        hasActionId: Boolean(actionId),
        hasIssuedAt: issuedAtRaw !== undefined,
        hasHmac: Boolean(providedHmac),
      });
      respondInteractiveAck();
      return;
    }

    const expectedHmac = computeMattermostContextHmac({
      hmacSecret: config.hmacSecret,
      intentId,
      actionId,
      issuedAt: issuedAtRaw,
    });

    if (!safeEqual(providedHmac, expectedHmac)) {
      // Always respond 200 — never reveal verification status to attackers.
      config.logger.warn("mattermost callback HMAC verification failed", {
        intentId,
        actionId,
        issuedAt: issuedAtRaw,
      });
      respondInteractiveAck();
      return;
    }

    let handlerResult: MattermostCallbackHandlerResult | void = undefined;
    try {
      handlerResult = await config.handler(body, rawBody);
    } catch (error) {
      config.logger.error("mattermost callback handler threw", {
        error: error instanceof Error ? error.message : String(error),
        intentId,
        actionId,
      });
    }

    respondInteractiveAck(handlerResult ?? undefined);
  };

  /**
   * Slash-command branch. Form-decode the body, validate the `token`
   * against the registered token set (constant-time), and delegate to
   * the configured `slashCommandHandler` if present. Same hardening
   * posture as bad-HMAC interactive callbacks: always respond 200,
   * never reveal verification status.
   */
  const handleSlashCommand = async (params: {
    rawBody: string;
    config: MattermostCallbackServerConfig;
    respond: (result?: MattermostSlashCommandResult) => void;
  }): Promise<void> => {
    const { rawBody, config: cfg, respond } = params;
    const body = parseSlashCommandBody(rawBody);
    if (!body) {
      cfg.logger.warn("mattermost slash command body unparseable; dropping", {
        bytes: rawBody.length,
      });
      respond();
      return;
    }
    if (!cfg.slashCommandHandler) {
      cfg.logger.warn("mattermost slash command received but no handler registered", {
        command: body.command,
      });
      respond();
      return;
    }
    const validTokens = cfg.validSlashCommandTokens;
    if (!validTokens || validTokens.size === 0) {
      cfg.logger.warn("mattermost slash command rejected — no tokens registered", {
        command: body.command,
      });
      respond();
      return;
    }
    if (!isAcceptedSlashCommandToken(body.token, validTokens)) {
      cfg.logger.warn("mattermost slash command token verification failed", {
        command: body.command,
        teamId: body.team_id,
      });
      respond();
      return;
    }
    let result: MattermostSlashCommandResult | void = undefined;
    try {
      result = await cfg.slashCommandHandler(body, rawBody);
    } catch (error) {
      cfg.logger.error("mattermost slash command handler threw", {
        error: error instanceof Error ? error.message : String(error),
        command: body.command,
      });
    }
    respond(result ?? undefined);
  };

  return {
    async start() {
      if (server) {
        return;
      }
      server = createServer((req, res) => {
        handleRequest(req, res).catch((error) => {
          config.logger.error("mattermost callback request crashed", {
            error: error instanceof Error ? error.message : String(error),
          });
          if (!res.headersSent) {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json");
            res.end('{"update":null}');
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        const errorHandler = (error: Error): void => {
          config.logger.error("mattermost callback listener failed to bind", {
            error: error.message,
            port: config.port,
          });
          reject(error);
        };
        server!.once("error", errorHandler);
        server!.listen(config.port, "127.0.0.1", () => {
          server!.off("error", errorHandler);
          config.logger.info?.("mattermost callback listener bound", {
            port: config.port,
            host: "127.0.0.1",
          });
          resolve();
        });
      });
    },
    async stop() {
      const current = server;
      if (!current) {
        return;
      }
      server = undefined;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
      });
    },
    signContext(payload) {
      const issuedAt = Date.now();
      const hmac = computeMattermostContextHmac({
        hmacSecret: config.hmacSecret,
        intentId: payload.intentId,
        actionId: payload.actionId,
        issuedAt,
      });
      return { hmac, issuedAt };
    },
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  } catch {
    return false;
  }
}

/**
 * Parse a Mattermost slash-command form-encoded body into our typed
 * shape. Returns undefined when required fields are missing — same
 * "always 200, log + drop" hardening posture as bad-HMAC interactive
 * callbacks. Multiple values for the same key (rare but legal in
 * `application/x-www-form-urlencoded`) take the first.
 */
export function parseSlashCommandBody(
  rawBody: string,
): MattermostSlashCommandBody | undefined {
  const params = new URLSearchParams(rawBody);
  const get = (key: string): string | undefined => {
    const value = params.get(key);
    return value !== null && value.length > 0 ? value : undefined;
  };
  const token = get("token");
  const teamId = get("team_id");
  const channelId = get("channel_id");
  const userId = get("user_id");
  const command = get("command");
  if (!token || !teamId || !channelId || !userId || !command) {
    return undefined;
  }
  return {
    token,
    team_id: teamId,
    team_domain: get("team_domain"),
    channel_id: channelId,
    channel_name: get("channel_name"),
    user_id: userId,
    user_name: get("user_name"),
    command,
    text: get("text") ?? "",
    trigger_id: get("trigger_id"),
    response_url: get("response_url"),
    root_id: get("root_id"),
  };
}

/**
 * Constant-time check that the provided token matches at least one
 * of the registered tokens. Iterates in O(N) over the set; N is the
 * count of registered slash commands across all teams the bot
 * belongs to (typically <20). The constant-time check fires per
 * candidate, so a forged token can't time-discriminate which slot
 * it almost-matched.
 */
export function isAcceptedSlashCommandToken(
  provided: string,
  validTokens: ReadonlySet<string>,
): boolean {
  let accepted = false;
  for (const candidate of validTokens) {
    if (safeEqual(provided, candidate)) {
      accepted = true;
    }
  }
  return accepted;
}
