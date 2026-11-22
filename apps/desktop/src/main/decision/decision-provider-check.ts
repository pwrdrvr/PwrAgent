import {
  DECISION_JEV_ENDPOINT,
  resolveDecisionModelSettings,
  type DecisionModelInfo,
  type DecisionModelListing,
  type DecisionProviderCheck,
  type DecisionProviderId,
  type DesktopDecisionModelSettings,
} from "@pwragent/shared/decision-models";
import { postSystemOne, systemOneErrorDetail, systemOneHeaders } from "./system-one";

const LOCAL_CHECK_TIMEOUT_MS = 3000;
const JEV_CHECK_TIMEOUT_MS = 15_000;
const JEV_LIST_TIMEOUT_MS = 8000;
/** More than any provider lists; a longer answer is cut, not trusted. */
const MAX_LISTED_MODELS = 100;

export type DecisionProviderCheckDeps = {
  settings: DesktopDecisionModelSettings;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
};

function record(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

/**
 * The models a System One server lists at `GET /v1/models`: `{ models: [{
 * name, description }] }`. TypeSafe's examples also read a bare array, so
 * that is accepted too. Ids longer than a model id may be are dropped.
 */
export function listedModels(body: unknown): DecisionModelInfo[] {
  const models = Array.isArray(body) ? body : record(body).models;
  if (!Array.isArray(models)) return [];
  const listed: DecisionModelInfo[] = [];
  for (const entry of models) {
    if (listed.length >= MAX_LISTED_MODELS) break;
    const name = record(entry).name;
    if (typeof name !== "string" || !name.trim() || name.trim().length > 200) continue;
    const description = record(entry).description;
    listed.push({
      id: name.trim(),
      ...(typeof description === "string" && description.trim() ? { description: description.trim().slice(0, 200) } : {}),
    });
  }
  return listed;
}

/**
 * Settings' Model picker: the models a provider offers, read from its
 * `GET /v1/models` with the saved key. TypeSafe lists what the account can
 * send; a local server lists what it serves. Runs no decision.
 */
export async function listDecisionModels(
  provider: DecisionProviderId,
  deps: DecisionProviderCheckDeps,
): Promise<DecisionModelListing> {
  if (provider === "jev" && !deps.apiKey) {
    return { ok: false, detail: "Add a TypeSafe API key to list the models your account can use." };
  }
  const endpoint = provider === "local" ? resolveDecisionModelSettings(deps.settings).localEndpoint : DECISION_JEV_ENDPOINT;
  const read = await readModelList(endpoint, deps, provider === "local" ? LOCAL_CHECK_TIMEOUT_MS : JEV_LIST_TIMEOUT_MS);
  switch (read.kind) {
    case "listed":
      return { ok: true, models: read.models };
    case "unreachable":
      return { ok: false, detail: provider === "local" ? `Nothing answered at ${endpoint}.` : "TypeSafe did not answer." };
    case "refused":
      return { ok: false, detail: provider === "local" ? "The server refused the API key." : "TypeSafe rejected the API key." };
    case "status":
      return { ok: false, detail: `${provider === "local" ? endpoint : "TypeSafe"} returned HTTP ${read.status} for its model list.` };
  }
}

type ModelListRead =
  | { kind: "listed"; models: DecisionModelInfo[] }
  | { kind: "unreachable" }
  | { kind: "refused" }
  | { kind: "status"; status: number };

/** `GET /v1/models` on a System One server, for the picker and the local check alike. */
async function readModelList(endpoint: string, deps: DecisionProviderCheckDeps, timeoutMs: number): Promise<ModelListRead> {
  const fetch = deps.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetch(`${endpoint}/v1/models`, {
      headers: systemOneHeaders(deps.apiKey),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { kind: "unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return response.status === 401 || response.status === 403
      ? { kind: "refused" }
      : { kind: "status", status: response.status };
  }
  return { kind: "listed", models: listedModels(await response.json().catch(() => undefined)) };
}

/**
 * Settings' "Check" for one decision provider, against what is saved. The
 * local check lists the server's models and reads its health, which runs no
 * decision; the Jev check asks one yes/no question, because its model list
 * leaves out pinned versions it still accepts, so only a decision shows the
 * key can run the chosen model.
 */
export async function checkDecisionProvider(
  provider: DecisionProviderId,
  deps: DecisionProviderCheckDeps,
): Promise<DecisionProviderCheck> {
  const resolved = resolveDecisionModelSettings(deps.settings);
  const fetch = deps.fetch ?? globalThis.fetch;
  if (provider === "local") {
    const endpoint = resolved.localEndpoint;
    const read = await readModelList(endpoint, deps, LOCAL_CHECK_TIMEOUT_MS);
    if (read.kind === "unreachable") return { ok: false, detail: `Nothing answered at ${endpoint}.` };
    if (read.kind === "refused") return { ok: false, detail: "The server refused the API key." };
    if (read.kind === "status") {
      return { ok: false, detail: `${endpoint} has no System One API. PwrAgent sends decisions to /v1/systemone.` };
    }
    const models = read.models.map((model) => model.id);
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
      const reply = await fetch(`${endpoint}/health`, {
        headers: systemOneHeaders(deps.apiKey),
        redirect: "error",
        signal: AbortSignal.timeout(LOCAL_CHECK_TIMEOUT_MS),
      });
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
