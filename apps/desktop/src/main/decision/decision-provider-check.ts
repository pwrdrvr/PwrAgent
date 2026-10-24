import {
  DECISION_JEV_ENDPOINT,
  resolveDecisionModelSettings,
  type DecisionProviderCheck,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared";
import { postSystemOne, systemOneErrorDetail, systemOneHeaders } from "./system-one";

const LOCAL_CHECK_TIMEOUT_MS = 3000;
const JEV_CHECK_TIMEOUT_MS = 15_000;

export type DecisionProviderCheckDeps = {
  settings: DesktopDecisionModelSettings;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

/** The model ids a System One server lists at `GET /v1/models`. */
function listedModels(body: unknown): string[] {
  const models = record(body).models;
  return Array.isArray(models)
    ? models.map((model) => record(model).name).filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * Settings' "Check" for one decision provider, against what is saved. The
 * local check lists the server's models and reads its health, which runs no
 * decision; the Jev check asks one yes/no question, because TypeSafe
 * documents no cheaper route.
 */
export async function checkDecisionProvider(
  provider: DecisionProviderId,
  deps: DecisionProviderCheckDeps,
): Promise<DecisionProviderCheck> {
  const resolved = resolveDecisionModelSettings(deps.settings);
  const fetch = deps.fetch ?? globalThis.fetch;
  if (provider === "local") {
    const endpoint = resolved.localEndpoint;
    const get = (path: string) => fetch(`${endpoint}${path}`, {
      headers: systemOneHeaders(deps.apiKey),
      redirect: "error",
      signal: AbortSignal.timeout(LOCAL_CHECK_TIMEOUT_MS),
    });
    let response: Response;
    try {
      response = await get("/v1/models");
    } catch {
      return { ok: false, detail: `Nothing answered at ${endpoint}.` };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { ok: false, detail: "The server refused the API key." };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { ok: false, detail: `${endpoint} has no System One API. PwrAgent sends decisions to /v1/systemone.` };
    }
    const models = listedModels(await response.json().catch(() => undefined));
    if (!models.includes(resolved.localModel)) {
      return {
        ok: false,
        detail: models.length
          ? `The server does not offer ${resolved.localModel}. It offers ${models.join(", ")}.`
          : `The server lists no models, so PwrAgent cannot confirm ${resolved.localModel}.`,
      };
    }
    // Load is extra: a System One server need not report it.
    let health: Record<string, unknown> = {};
    try {
      const reply = await get("/health");
      if (reply.ok) health = record(await reply.json().catch(() => undefined));
      else await reply.body?.cancel();
    } catch {
      // The model list already answered.
    }
    const count = (key: string) => typeof health[key] === "number" && Number.isFinite(health[key]) ? health[key] as number : undefined;
    const inFlight = count("requests_processing");
    const completed = count("completed_decisions");
    return {
      ok: true,
      detail: [
        `Ready with ${resolved.localModel}`,
        completed === undefined ? undefined : `${completed} decisions served`,
        inFlight === undefined ? undefined : `${inFlight} in flight`,
      ].filter(Boolean).join(" · ") + ".",
    };
  }
  if (!deps.apiKey) return { ok: false, detail: "Add a TypeSafe API key first." };
  let response: Response;
  try {
    response = await postSystemOne(
      { endpoint: DECISION_JEV_ENDPOINT, model: resolved.jevModel, apiKey: deps.apiKey },
      {
        state: "PwrAgent is checking its connection to Jev.",
        questions: { check: { type: "noul", instructions: "Is this a connection check?" } },
      },
      { signal: AbortSignal.timeout(JEV_CHECK_TIMEOUT_MS), fetch },
    );
  } catch {
    return { ok: false, detail: "TypeSafe did not answer." };
  }
  if (!response.ok) {
    switch (response.status) {
      case 401:
        await response.body?.cancel();
        return { ok: false, detail: "TypeSafe rejected the API key." };
      case 422: {
        const detail = await systemOneErrorDetail(response);
        return { ok: false, detail: `TypeSafe rejected the request${detail ? `: ${detail}` : ""}. Check the model id (${resolved.jevModel}).` };
      }
      case 429:
      case 529:
        await response.body?.cancel();
        return { ok: false, detail: "TypeSafe is rate limiting or overloaded. Try again shortly." };
      default:
        await response.body?.cancel();
        return { ok: false, detail: `TypeSafe returned HTTP ${response.status}.` };
    }
  }
  const model = record(await response.json().catch(() => undefined)).model;
  return { ok: true, detail: `Answered with ${typeof model === "string" ? model : resolved.jevModel}.` };
}
