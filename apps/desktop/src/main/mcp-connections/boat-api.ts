import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { BOAT_API_URL, redactBoatApiKeys } from "@pwragent/shared/contracts/mcp-connections";

/**
 * The one place a Boat API key is attached to a request.
 *
 * The key is read for each request, so a disconnect or a new key applies to
 * the next call. Every request goes to Boat's fixed API address and refuses
 * redirects, so the bearer header cannot follow one to another host. Every
 * error this throws has had anything shaped like a Boat key removed, because
 * its message can reach an agent.
 *
 * `redact` removes the exact keys this process has sent. Tool results carry
 * file contents and command output, where a pattern would also rewrite
 * ordinary text such as `box_shadow_radius`.
 */

const KEY_REMOVED = "[Boat key removed]";

const REQUEST_TIMEOUT_MS = 60_000;
const ERROR_TEXT_LIMIT = 400;
/** A retry never waits longer than this; a longer Retry-After is reported. */
const MAX_RETRY_WAIT_MS = 10_000;

export type BoatApiErrorKind = "not_connected" | "rejected" | "not_found" | "limited" | "unavailable" | "failed";

export class BoatApiError extends Error {
  constructor(
    message: string,
    readonly kind: BoatApiErrorKind,
    readonly status?: number,
    readonly code?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(redactBoatApiKeys(message));
    this.name = "BoatApiError";
  }
}

export type BoatApiRequest = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path segments under the API root. Each is percent-encoded here. */
  path: readonly string[];
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Longer than the default for a waiting command. */
  timeoutMs?: number;
};

export type BoatApiOptions = {
  /** The stored key, or undefined when none is stored. */
  readKey: () => Promise<string | undefined>;
  fetchFn: FetchLike;
  /** Boat answered 401 or an expired-key 403 for the key just used. */
  onRejected?: () => void;
  /** Boat refused to create a sandbox because the stored key may not. */
  onCannotCreate?: () => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export class BoatApi {
  /** Every key sent since launch, in memory only, for `redact`. */
  private readonly sentKeys = new Set<string>();

  constructor(private readonly options: BoatApiOptions) {}

  /** `text` without any key this process has sent to Boat. */
  redact(text: string): string {
    let redacted = text;
    for (const key of this.sentKeys) redacted = redacted.replaceAll(key, KEY_REMOVED);
    return redacted;
  }

  /** Uses the stored key. */
  async request(request: BoatApiRequest): Promise<Record<string, unknown>> {
    const key = await this.options.readKey();
    if (!key) {
      throw new BoatApiError(
        "Boat is not connected. The operator connects it in Settings → Plugins.",
        "not_connected",
      );
    }
    return await this.requestWithKey(key, request, true);
  }

  /** Checks a key that is not stored yet. Never reports a rejection. */
  async requestWithKey(
    key: string,
    request: BoatApiRequest,
    stored = false,
  ): Promise<Record<string, unknown>> {
    this.sentKeys.add(key);
    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.send(key, request);
      if (answer.ok) return answer.body;
      const error = answer.error;
      if (error.kind === "rejected" && stored) this.options.onRejected?.();
      if (
        stored
        && error.code === "api_key_action_forbidden"
        && request.method === "POST"
        && request.path.length === 1
        && request.path[0] === "sandboxes"
      ) {
        this.options.onCannotCreate?.();
      }
      const waitMs = retryWaitMs(error);
      if (attempt > 0 || waitMs === undefined) throw error;
      await (this.options.sleep ?? sleep)(waitMs, request.signal);
    }
  }

  private async send(
    key: string,
    request: BoatApiRequest,
  ): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: BoatApiError }> {
    const url = new URL(`${BOAT_API_URL}/${request.path.map(encodeURIComponent).join("/")}`);
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const timeout = AbortSignal.timeout(request.timeoutMs ?? REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.options.fetchFn(url, {
        method: request.method,
        headers: {
          accept: "application/json",
          ...(request.body ? { "content-type": "application/json" } : {}),
          ...request.headers,
          authorization: `Bearer ${key}`,
        },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        redirect: "error",
        signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
      });
    } catch (cause) {
      if (request.signal?.aborted) throw cause;
      return {
        ok: false,
        error: new BoatApiError(
          timeout.aborted ? "Boat did not answer in time." : "Could not reach Boat.",
          "unavailable",
        ),
      };
    }
    const text = await response.text().catch(() => "");
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON answer is described by its status alone.
    }
    if (response.ok && body.ok !== false) return { ok: true, body };
    return { ok: false, error: describeFailure(response, body) };
  }
}

function describeFailure(response: Response, body: Record<string, unknown>): BoatApiError {
  const status = response.status;
  const code = typeof body.code === "string" ? body.code.slice(0, 80) : undefined;
  const detail = body.error && typeof body.error === "object"
    ? (body.error as { message?: unknown }).message
    : body.error ?? body.message;
  const said = typeof detail === "string" && detail.trim()
    ? redactBoatApiKeys(detail.trim()).slice(0, ERROR_TEXT_LIMIT)
    : undefined;
  const retryAfter = Number(response.headers.get("retry-after"));
  const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
  if (status === 401 || code === "api_key_expired") {
    return new BoatApiError(
      "Boat rejected the stored API key. The operator reconnects Boat in Settings → Plugins.",
      "rejected", status, code,
    );
  }
  if (code === "api_key_action_forbidden" || code === "api_key_sandbox_forbidden") {
    return new BoatApiError(
      `The stored Boat API key is not allowed to do this (${code}). The operator replaces it by signing in to Boat again in Settings → Plugins.`,
      "failed", status, code,
    );
  }
  if (status === 404) {
    return new BoatApiError(said ?? "Boat reports that this does not exist (404).", "not_found", status, code);
  }
  if (status === 402 || status === 429) {
    return new BoatApiError(
      `${said ?? "Boat refused this for the account's plan or limits"} (${code ?? status}).${
        retryAfterSeconds ? ` Retry after ${Math.ceil(retryAfterSeconds)} s.` : ""
      }`,
      "limited", status, code, retryAfterSeconds,
    );
  }
  if (status === 503) {
    return new BoatApiError(
      `${said ?? "Boat is temporarily unavailable"} (${code ?? status}).`,
      "unavailable", status, code, retryAfterSeconds,
    );
  }
  return new BoatApiError(`${said ?? "Boat reported an error"} (${code ?? status}).`, "failed", status, code);
}

/**
 * One retry, and only where Boat says a retry is the answer: no machine was
 * ready, or a start-rate limit that clears within seconds. A full plan or an
 * unpaid account is reported at once.
 */
function retryWaitMs(error: BoatApiError): number | undefined {
  if (error.code === "no_ready_machine") return 5_000;
  if (error.code === "rate_limited" && error.retryAfterSeconds !== undefined) {
    const waitMs = error.retryAfterSeconds * 1_000;
    return waitMs <= MAX_RETRY_WAIT_MS ? waitMs : undefined;
  }
  return undefined;
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Cancelled."));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
