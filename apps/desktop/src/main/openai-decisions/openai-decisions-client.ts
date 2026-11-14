import {
  OPENAI_DECISIONS_ENDPOINT,
  redactOpenAIDecisionsText,
  type OpenAIDecisionsRequestBody,
} from "@pwragent/shared/openai-decisions";

/**
 * The HTTP half of registered OpenAI Decisions: one `POST /v1/decisions`
 * with the documented body. This is deliberately separate from
 * `decision/system-one.ts`; it shares no request shape with Clef or Jev and
 * never falls back to them, to Responses, or to the parent model.
 */

export const OPENAI_DECISIONS_TIMEOUT_MS = 30_000;
export const OPENAI_DECISIONS_MAX_RETRIES = 2;
export const OPENAI_DECISIONS_MAX_RETRY_AFTER_MS = 20_000;

export type OpenAIDecisionsFailureCode =
  | "credential_rejected"
  | "model_unavailable"
  | "rate_limited"
  | "overloaded"
  | "upstream_error";

/** One HTTP attempt. `usage` is the raw object when the body carried one. */
export type OpenAIDecisionsAttempt = {
  status?: number;
  requestId?: string;
  usage?: unknown;
  model?: string;
};

export type OpenAIDecisionsHttpResult =
  | {
      ok: true;
      status: number;
      requestId?: string;
      body: Record<string, unknown>;
      attempts: OpenAIDecisionsAttempt[];
    }
  | {
      ok: false;
      code: OpenAIDecisionsFailureCode;
      status?: number;
      requestId?: string;
      /** Upstream text, redacted and capped at 200 characters. */
      detail?: string;
      attempts: OpenAIDecisionsAttempt[];
    };

export type OpenAIDecisionsHttpOptions = {
  body: OpenAIDecisionsRequestBody;
  /** Read by the caller from the secret store immediately before this call. */
  apiKey: string;
  organizationId?: string;
  projectId?: string;
  /** Tests point this at a local mock server. Production uses the constant. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
};

export async function postOpenAIDecision(
  options: OpenAIDecisionsHttpOptions,
): Promise<OpenAIDecisionsHttpResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? abortableSleep;
  const attempts: OpenAIDecisionsAttempt[] = [];
  const serializedBody = JSON.stringify(options.body);
  for (let attempt = 0; ; attempt += 1) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? OPENAI_DECISIONS_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(options.endpoint ?? OPENAI_DECISIONS_ENDPOINT, {
        method: "POST",
        headers: openAIDecisionsHeaders(options),
        body: serializedBody,
        signal,
        redirect: "error",
      });
    } catch (error) {
      const timedOut = timeout.aborted && !options.signal?.aborted;
      return {
        ok: false,
        code: "upstream_error",
        detail: timedOut
          ? "The request timed out."
          : options.signal?.aborted
            ? "The request was cancelled."
            : redactOpenAIDecisionsText(errorText(error), [options.apiKey]),
        attempts,
      };
    }
    const requestId = response.headers.get("x-request-id") ?? undefined;
    const parsed: unknown = await response.json().catch(() => undefined);
    const body = isRecord(parsed) ? parsed : undefined;
    attempts.push({
      status: response.status,
      ...(requestId ? { requestId } : {}),
      ...(body && "usage" in body ? { usage: body.usage } : {}),
      ...(body && typeof body.model === "string" ? { model: body.model } : {}),
    });
    if (response.ok) {
      if (!body) {
        return {
          ok: false,
          code: "upstream_error",
          status: response.status,
          ...(requestId ? { requestId } : {}),
          detail: "The response was not a JSON object.",
          attempts,
        };
      }
      return { ok: true, status: response.status, ...(requestId ? { requestId } : {}), body, attempts };
    }
    const error = isRecord(body?.error) ? body.error : undefined;
    const errorCode = typeof error?.code === "string" ? error.code : undefined;
    const detail = typeof error?.message === "string"
      ? redactOpenAIDecisionsText(error.message, [options.apiKey])
      : undefined;
    const failure = {
      status: response.status,
      ...(requestId ? { requestId } : {}),
      ...(detail ? { detail } : {}),
      attempts,
    };
    const retryable =
      (response.status === 429 && errorCode === "slow_down")
      || (response.status === 503 && errorCode === "server_is_overloaded");
    const retryAfterMs = retryable ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
    if (
      retryable
      && retryAfterMs !== undefined
      && retryAfterMs <= OPENAI_DECISIONS_MAX_RETRY_AFTER_MS
      && attempt < OPENAI_DECISIONS_MAX_RETRIES
    ) {
      try {
        await sleep(retryAfterMs, options.signal);
      } catch {
        return { ok: false, code: response.status === 429 ? "rate_limited" : "overloaded", ...failure };
      }
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: "credential_rejected", ...failure };
    }
    if (response.status === 404 || errorCode === "model_not_found") {
      return { ok: false, code: "model_unavailable", ...failure };
    }
    if (response.status === 429) return { ok: false, code: "rate_limited", ...failure };
    if (response.status === 503) return { ok: false, code: "overloaded", ...failure };
    return { ok: false, code: "upstream_error", ...failure };
  }
}

/** Headers for one request. The bearer value never leaves this object. */
export function openAIDecisionsHeaders(options: {
  apiKey: string;
  organizationId?: string;
  projectId?: string;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${options.apiKey}`,
    "Content-Type": "application/json",
    ...(options.organizationId ? { "OpenAI-Organization": options.organizationId } : {}),
    ...(options.projectId ? { "OpenAI-Project": options.projectId } : {}),
  };
}

/** Seconds, or an HTTP date. Anything else is not a valid Retry-After. */
export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
