import {
  DECISION_JEV_ENDPOINT,
  resolveDecisionModelSettings,
  type DecisionProviderCheck,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared";

const LOCAL_CHECK_TIMEOUT_MS = 3000;
const JEV_CHECK_TIMEOUT_MS = 15_000;

export type DecisionProviderCheckDeps = {
  settings: DesktopDecisionModelSettings;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

/**
 * Settings' "Check" for one decision provider, against what is saved. The
 * local check reads the server's health, which runs no decision; the Jev check
 * asks one yes/no question, because TypeSafe documents no cheaper route.
 */
export async function checkDecisionProvider(
  provider: DecisionProviderId,
  deps: DecisionProviderCheckDeps,
): Promise<DecisionProviderCheck> {
  const resolved = resolveDecisionModelSettings(deps.settings);
  const fetch = deps.fetch ?? globalThis.fetch;
  const auth: Record<string, string> = deps.apiKey ? { Authorization: `Bearer ${deps.apiKey}` } : {};
  if (provider === "local") {
    const endpoint = resolved.localEndpoint;
    let response: Response;
    try {
      response = await fetch(`${endpoint}/health`, {
        headers: auth,
        redirect: "error",
        signal: AbortSignal.timeout(LOCAL_CHECK_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, detail: `Nothing answered at ${endpoint}.` };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { ok: false, detail: "The server refused the API key." };
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Reachable, but not a server that reports its load.
      return { ok: true, detail: `${endpoint} answered, but has no health route, so PwrAgent cannot see how busy it is.` };
    }
    const body: unknown = await response.json().catch(() => undefined);
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const count = (key: string) => typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] as number : undefined;
    const inFlight = count("requests_processing");
    const completed = count("completed_decisions");
    return {
      ok: true,
      detail: [
        "Ready",
        completed === undefined ? undefined : `${completed} decisions served`,
        inFlight === undefined ? undefined : `${inFlight} in flight`,
      ].filter(Boolean).join(" · ") + ".",
    };
  }
  if (!deps.apiKey) return { ok: false, detail: "Add a TypeSafe API key first." };
  let response: Response;
  try {
    response = await fetch(DECISION_JEV_ENDPOINT, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: resolved.jevModel,
        state: "PwrAgent is checking its connection to Jev.",
        questions: { check: { type: "noul", instructions: "Is this a connection check?" } },
      }),
      redirect: "error",
      signal: AbortSignal.timeout(JEV_CHECK_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, detail: "TypeSafe did not answer." };
  }
  if (!response.ok) {
    await response.body?.cancel();
    switch (response.status) {
      case 401:
        return { ok: false, detail: "TypeSafe rejected the API key." };
      case 422:
        return { ok: false, detail: `TypeSafe rejected the request. Check the model id (${resolved.jevModel}).` };
      case 429:
      case 529:
        return { ok: false, detail: "TypeSafe is rate limiting or overloaded. Try again shortly." };
      default:
        return { ok: false, detail: `TypeSafe returned HTTP ${response.status}.` };
    }
  }
  const body: unknown = await response.json().catch(() => undefined);
  const model = body && typeof body === "object" && typeof (body as Record<string, unknown>).model === "string"
    ? (body as Record<string, unknown>).model as string
    : resolved.jevModel;
  return { ok: true, detail: `Answered with ${model}.` };
}
