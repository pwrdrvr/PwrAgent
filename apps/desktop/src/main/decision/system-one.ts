import { DECISION_SYSTEM_ONE_PATH } from "@pwragent/shared";

/**
 * A server that speaks TypeSafe's System One API: TypeSafe's hosted Jev, or a
 * local one such as PwrSuiteLab's Clef runtime. Its base URL, the model id it
 * expects, and an optional bearer key.
 */
export type SystemOneTarget = { endpoint: string; model: string; apiKey?: string };

export type SystemOneRequest = {
  state: unknown;
  questions: Record<string, unknown>;
  /** Clef's extension to the API: up to four inline images. Jev takes none. */
  images?: string[];
};

export function systemOneHeaders(apiKey: string | undefined, json = false): Record<string, string> {
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** POSTs one decision request. The caller reads or cancels the response. */
export function postSystemOne(
  target: SystemOneTarget,
  request: SystemOneRequest,
  init: { signal: AbortSignal; fetch?: typeof globalThis.fetch },
): Promise<Response> {
  return (init.fetch ?? globalThis.fetch)(`${target.endpoint}${DECISION_SYSTEM_ONE_PATH}`, {
    method: "POST",
    headers: systemOneHeaders(target.apiKey, true),
    body: JSON.stringify({
      model: target.model,
      state: request.state,
      questions: request.questions,
      ...(request.images ? { images: request.images } : {}),
    }),
    signal: init.signal,
    redirect: "error",
  });
}

/** A request the server refused outright; sending it again cannot succeed. */
export class SystemOneRejected extends Error {
  constructor(readonly status: number, readonly detail: string | undefined) {
    super(`The decision model returned HTTP ${status}${detail ? `: ${detail}` : ""}.`);
    this.name = "SystemOneRejected";
  }
}

/** Refusals other than a full queue or a timeout. */
export function isSystemOneRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The server's reason for a failed request, when it gave a short one. */
export async function systemOneErrorDetail(response: Response): Promise<string | undefined> {
  const body: unknown = await response.json().catch(() => undefined);
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object" ? (record.error as Record<string, unknown>).message : record.error;
  const detail = [record.detail, nested, record.message].find((value) => typeof value === "string" && value.trim());
  return typeof detail === "string" ? detail.trim().slice(0, 200) : undefined;
}
