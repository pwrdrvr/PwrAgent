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
    const respondAck = (
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
          respondAck();
          return;
        }
      }
    } catch (error) {
      config.logger.error("mattermost callback body read failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      respondAck();
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
      respondAck();
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
      respondAck();
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
      respondAck();
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

    respondAck(handlerResult ?? undefined);
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
