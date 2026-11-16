import {
  BONSAI_2_27B_DISPLAY_NAME,
  BONSAI_2_27B_MODEL_ID,
  formatCodexProviderModelId,
  parseCodexProviderCatalogModel,
  type BackendModelOption,
  type CodexModelProviderCatalogState,
  type CodexModelProviderSettings,
  type CodexModelProviderTestResult,
  type CodexProviderCatalogModel,
} from "@pwragent/shared";
import { prepareBonsaiRuntime } from "../codex-app-server/bonsai-runtime";
import { verifyProviderToolDiscovery } from "./provider-tool-discovery-probe";

const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * A `/models` page carries per-model metadata (descriptions, pricing,
 * architecture), so a few hundred models from an aggregator can exceed 1 MiB.
 */
const MAX_MODELS_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 2_000;
const MAX_MODEL_PAGES = 20;
const MAX_ERROR_LENGTH = 200;

function providerModelOptions(
  provider: CodexModelProviderSettings,
  discovered: readonly CodexProviderCatalogModel[],
): BackendModelOption[] {
  const byId = new Map(discovered.map((model) => [model.id, model]));
  for (const metadata of provider.modelMetadata ?? []) {
    byId.set(metadata.id, { ...byId.get(metadata.id), ...metadata });
  }
  const ids = [...new Set([...(provider.models ?? []), ...discovered.map((model) => model.id)])];
  return ids.map((model): BackendModelOption => {
    const found = byId.get(model);
    const efforts = found?.reasoningEfforts ?? [];
    return {
      id: formatCodexProviderModelId(provider.id, model),
      label: found?.label || (provider.compatibility === "bonsai" && model === BONSAI_2_27B_MODEL_ID
        ? BONSAI_2_27B_DISPLAY_NAME : model),
      providerId: provider.id,
      providerLabel: provider.name,
      // Codex sends any effort as `reasoning.effort`, for any model, so a
      // provider model offers the levels its endpoint declares. A model
      // the endpoint names none for (or only listed in Settings) takes
      // the endpoint's default.
      supportsReasoning: efforts.length > 0,
      ...(efforts.length ? { reasoningEfforts: [...efforts] } : {}),
      ...(found?.defaultReasoningEffort ? { defaultReasoningEffort: found.defaultReasoningEffort } : {}),
      ...(found?.supportsImage === undefined ? {} : { supportsImage: found.supportsImage }),
      supportsFast: false,
    };
  });
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type Discovery = {
  models: CodexProviderCatalogModel[];
  /** The endpoint had more models than `MAX_DISCOVERED_MODELS`. */
  truncated: boolean;
  /** Pages read, for Test connection. */
  pages: number;
};

type DiscoveryState = {
  fingerprint: string;
  expiresAt: number;
  /** The last read, when it succeeded. */
  discovery?: Discovery;
  /** Why the last read failed, already redacted. */
  error?: string;
  /** When the last successful read finished. */
  readAt?: number;
  promise?: Promise<void>;
};

/**
 * Model ids for each Codex model provider, as model options for the `codex`
 * backend. Every surface that lists Codex models (the composer, federation
 * peers, messaging pickers and the Agent tools) reads them from there.
 *
 * Discovery reads the provider's OpenAI-compatible `GET /models` with that
 * provider's own base URL and key. It follows OpenAI list pagination
 * (`has_more` plus `after=<last id>`) and is bounded: one read per provider
 * per ten minutes (one minute after a failure), an eight-second timeout per
 * page, 8 MiB per page, 20 pages, 2,000 models, no redirects. A failed read
 * falls back to the ids the operator listed, so a provider that is down still
 * shows its known models, and `catalogStates` says why the rest are missing.
 */
export class CodexModelProviderCatalog {
  private readonly discovery = new Map<string, DiscoveryState>();

  constructor(private readonly options: {
    resolveProviders: () => CodexModelProviderSettings[];
    resolveKeys: () => Promise<Record<string, string>>;
    fetch?: FetchLike;
    now?: () => number;
    prepareCompatibility?: typeof prepareBonsaiRuntime;
    verifyPortable?: (provider: CodexModelProviderSettings, apiKey: string | undefined) => Promise<{ requests: number; initialToolBytes?: number; initialRequestBytes?: number }>;
  }) {}

  invalidate(): void {
    this.discovery.clear();
  }

  /** Forget one provider's last read, so the next list reads it again. */
  invalidateProvider(providerId: string): void {
    this.discovery.delete(providerId);
  }

  async listModelOptions(): Promise<BackendModelOption[]> {
    const providers = this.options.resolveProviders();
    if (providers.length === 0) return [];
    const keys = await this.options.resolveKeys().catch((): Record<string, string> => ({}));
    const perProvider = await Promise.all(providers.map(async (provider) => {
      const discovered = provider.discoverModels === false
        ? []
        : (await this.discover(provider, keys[provider.id])).discovery?.models ?? [];
      return providerModelOptions(provider, discovered);
    }));
    return perProvider.flat();
  }

  /**
   * Each configured provider's listed models plus those its last successful
   * read of its current base URL found, with each provider's catalog state,
   * from one read of the provider list and without reading any endpoint. A
   * summary published without a Codex model read (before discovery, after a
   * provider change replaced the runtime, or after that read failed) offers
   * these.
   */
  knownCatalog(): { models: BackendModelOption[]; states: CodexModelProviderCatalogState[] } {
    const providers = this.options.resolveProviders();
    return {
      models: providers.flatMap((provider) =>
        providerModelOptions(provider, this.currentRead(provider)?.discovery?.models ?? [])),
      states: providers.map((provider) => this.catalogState(provider)),
    };
  }

  /**
   * What each configured provider's last catalog read found, in configured
   * order. It never reads an endpoint itself; `listModelOptions` does.
   */
  catalogStates(): CodexModelProviderCatalogState[] {
    return this.options.resolveProviders().map((provider) => this.catalogState(provider));
  }

  /**
   * The provider's last read, when it read the provider's current base URL.
   * A read of a base URL the provider no longer has says nothing about it.
   */
  private currentRead(provider: CodexModelProviderSettings): DiscoveryState | undefined {
    if (provider.discoverModels === false) return undefined;
    const state = this.discovery.get(provider.id);
    return state?.fingerprint.startsWith(`${provider.baseUrl}\u0000`) ? state : undefined;
  }

  private catalogState(provider: CodexModelProviderSettings): CodexModelProviderCatalogState {
    const base = { id: provider.id, name: provider.name, listedCount: provider.models?.length ?? 0 };
    if (provider.discoverModels === false) return { ...base, status: "off" };
    const state = this.currentRead(provider);
    if (!state) return { ...base, status: "pending" };
    if (state.error !== undefined) return { ...base, status: "unavailable", error: state.error };
    if (!state.discovery) return { ...base, status: "pending" };
    return {
      ...base,
      status: "ready",
      discoveredCount: state.discovery.models.length,
      ...(state.discovery.truncated ? { truncated: true } : {}),
      ...(state.readAt === undefined ? {} : { readAt: state.readAt }),
    };
  }

  private async discover(
    provider: CodexModelProviderSettings,
    apiKey: string | undefined,
  ): Promise<DiscoveryState> {
    const now = this.options.now?.() ?? Date.now();
    const fingerprint = `${provider.baseUrl}\u0000${apiKey ? "key" : ""}`;
    const cached = this.discovery.get(provider.id);
    if (cached?.fingerprint === fingerprint) {
      if (cached.promise) {
        await cached.promise;
        return cached;
      }
      if (cached.expiresAt > now) return cached;
    }
    const state: DiscoveryState = { fingerprint, expiresAt: 0 };
    state.promise = this.fetchModels(provider.baseUrl, apiKey)
      .then((discovery) => {
        state.discovery = discovery;
        state.readAt = this.options.now?.() ?? Date.now();
        state.expiresAt = now + DISCOVERY_TTL_MS;
      }, (error: unknown) => {
        // A failed read offers only the listed models, as the picker says.
        state.error = redactSecret(errorMessage(error), apiKey);
        state.expiresAt = now + DISCOVERY_FAILURE_TTL_MS;
      })
      .finally(() => {
        state.promise = undefined;
      });
    this.discovery.set(provider.id, state);
    await state.promise;
    return state;
  }

  private async fetchModels(baseUrl: string, apiKey: string | undefined): Promise<Discovery> {
    const models: CodexProviderCatalogModel[] = [];
    const seen = new Set<string>();
    let after: string | undefined;
    let pages = 0;
    for (;;) {
      pages += 1;
      const url = after ? `${baseUrl}/models?after=${encodeURIComponent(after)}` : `${baseUrl}/models`;
      const body = await this.requestJson(url, { method: "GET" }, apiKey, MAX_MODELS_RESPONSE_BYTES);
      const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
      const data = Array.isArray(record?.data) ? record.data : Array.isArray(body) ? body : [];
      let added = 0;
      let lastId: string | undefined;
      for (const entry of data) {
        const item = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
        const id = typeof item?.id === "string" ? item.id.trim() : "";
        if (id) lastId = id;
        const model = parseCodexProviderCatalogModel(entry);
        if (!model || seen.has(model.id)) continue;
        if (models.length >= MAX_DISCOVERED_MODELS) return { models, truncated: true, pages };
        seen.add(model.id);
        models.push(model);
        added += 1;
      }
      const hasMore = record?.has_more === true;
      const next = typeof record?.last_id === "string" && record.last_id ? record.last_id : lastId;
      // A page that adds nothing new, or names the cursor it was asked for,
      // would loop. Stop there and keep what was read.
      if (!hasMore || !next || added === 0 || next === after) return { models, truncated: false, pages };
      if (models.length >= MAX_DISCOVERED_MODELS || pages >= MAX_MODEL_PAGES) {
        return { models, truncated: true, pages };
      }
      after = next;
    }
  }

  /**
   * Check a provider before Codex reconnects to it. Sends one `GET /models`
   * and, when a model is known, one short `POST /responses`, which the
   * provider may bill.
   */
  async test(
    provider: CodexModelProviderSettings,
    apiKey: string | undefined,
  ): Promise<CodexModelProviderTestResult> {
    const startedAt = this.options.now?.() ?? Date.now();
    let models: CodexProviderCatalogModel[] = [];
    let modelPages: Pick<Discovery, "pages" | "truncated"> | undefined;
    let modelsError: string | undefined;
    try {
      const discovery = await this.fetchModels(provider.baseUrl, apiKey);
      models = discovery.models;
      modelPages = { pages: discovery.pages, truncated: discovery.truncated };
    } catch (error) {
      modelsError = redactSecret(errorMessage(error), apiKey);
    }
    const reachedAfterMs = (this.options.now?.() ?? Date.now()) - startedAt;
    const probeModel = provider.models?.[0] ?? models[0]?.id;
    if (!probeModel) {
      return {
        models: modelsTestResult(models, modelPages, modelsError),
        responses: { ok: false, skipped: true, error: "No model to try. List one, or let the endpoint list its models." },
        latencyMs: reachedAfterMs,
      };
    }
    let responsesError: string | undefined;
    let discovery: CodexModelProviderTestResult["discovery"];
    let portableDiscovery: CodexModelProviderTestResult["portableDiscovery"];
    const effort = models.find((model) => model.id === probeModel)?.reasoningEfforts?.[0]
      ?? provider.modelMetadata?.find((model) => model.id === probeModel)?.reasoningEfforts?.[0];
    let runtime: Awaited<ReturnType<typeof prepareBonsaiRuntime>> | undefined;
    try {
      if (provider.compatibility === "bonsai") {
        runtime = await (this.options.prepareCompatibility ?? prepareBonsaiRuntime)(provider, apiKey);
      }
      const response = await this.requestJson(`${runtime?.baseUrl ?? provider.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: probeModel,
          ...(effort ? { reasoning: { effort } } : {}),
          instructions: "You are checking compatibility with a coding assistant. Reply with OK.",
          input: [
            { role: "developer", content: "Do not call tools for this check." },
            { role: "user", content: "Reply with OK." },
          ],
          tools: [{
            type: "namespace",
            name: "compatibility_check",
            description: "Tools exposed by the coding assistant.",
            tools: [{
              type: "function",
              name: "check",
              description: "A compatibility check; do not call it.",
              parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
              strict: true,
            }],
          }],
          max_output_tokens: 256,
          store: false,
        }),
      }, apiKey);
      if (!hasCompletedTextResponse(response)) {
        throw new Error("The endpoint did not return a completed text response. Compatibility with Codex was not confirmed.");
      }
      let requests = 0;
      try {
        await verifyProviderToolDiscovery(probeModel, async (body) => {
          requests += 1;
          return await this.requestJson(`${runtime?.baseUrl ?? provider.baseUrl}/responses`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          }, apiKey);
        }, effort);
        discovery = { ok: true, model: probeModel, requests };
      } catch (error) {
        discovery = { ok: false, model: probeModel, requests, error: redactSecret(errorMessage(error), apiKey) };
      }
    } catch (error) {
      responsesError = redactSecret(errorMessage(error), apiKey);
    } finally {
      await runtime?.close();
    }
    if (provider.toolDiscovery === "portable") {
      try {
        if (!this.options.verifyPortable) throw new Error("Portable discovery testing is unavailable on this instance.");
        const checked = await this.options.verifyPortable({ ...provider, models: [probeModel],
          modelMetadata: [{ ...models.find(model => model.id === probeModel), ...provider.modelMetadata?.find(model => model.id === probeModel), id: probeModel }] }, apiKey);
        portableDiscovery = { ok: true, model: probeModel, ...checked };
      } catch (error) {
        portableDiscovery = { ok: false, model: probeModel, requests: 0, error: redactSecret(errorMessage(error), apiKey) };
      }
    }
    return {
      models: modelsTestResult(models, modelPages, modelsError),
      responses: { ok: !responsesError, model: probeModel, ...(responsesError ? { error: responsesError } : {}) },
      ...(discovery ? { discovery } : {}),
      ...(portableDiscovery ? { portableDiscovery } : {}),
      latencyMs: reachedAfterMs,
    };
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    apiKey: string | undefined,
    maxBytes = MAX_RESPONSE_BYTES,
  ): Promise<unknown> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
        headers: {
          accept: "application/json",
          ...(init.headers as Record<string, string> | undefined),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      const text = await readBoundedText(response, maxBytes);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${describeErrorBody(text)}`);
      }
      return text ? JSON.parse(text) as unknown : undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}

function modelsTestResult(
  models: CodexProviderCatalogModel[],
  pages: Pick<Discovery, "pages" | "truncated"> | undefined,
  error: string | undefined,
): CodexModelProviderTestResult["models"] {
  return {
    ok: !error,
    count: models.length,
    ...(pages && pages.pages > 1 ? { pages: pages.pages } : {}),
    ...(pages?.truncated ? { truncated: true } : {}),
    ...(error ? { error } : { items: models }),
  };
}

function hasCompletedTextResponse(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const response = value as { status?: unknown; output?: unknown };
  if (response.status !== "completed" || !Array.isArray(response.output)) return false;
  return response.output.some((item: unknown) => {
    if (!item || typeof item !== "object") return false;
    const message = item as { type?: unknown; content?: unknown };
    return message.type === "message" && Array.isArray(message.content)
      && message.content.some((part: unknown) => {
        if (!part || typeof part !== "object") return false;
        const text = part as { type?: unknown; text?: unknown };
        return text.type === "output_text" && typeof text.text === "string" && Boolean(text.text.trim());
      });
  });
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = `The response was larger than ${maxBytes / (1024 * 1024)} MiB.`;
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > maxBytes) throw new Error(tooLarge);
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(tooLarge);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function describeErrorBody(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    const message = typeof body.error === "string"
      ? body.error
      : typeof body.error?.message === "string" ? body.error.message
      : typeof body.message === "string" ? body.message : undefined;
    return message ? `: ${message.slice(0, 200)}` : "";
  } catch {
    return "";
  }
}

/** A word of error text, masking characters and ellipses included. */
const ERROR_TEXT_TOKEN = /[\p{L}\p{N}_*.\u2026-]+/gu;

/**
 * An endpoint's error text can quote the key it was sent: whole, cut short,
 * or masked (`abcd****wxyz`, `...wxyz9`). Before the text reaches a window,
 * a peer or a log, every word that holds any 4-character run of the key
 * becomes `[key]`, as does any word shaped like an API key.
 */
function redactSecret(text: string, apiKey: string | undefined): string {
  let redacted = text;
  if (apiKey && apiKey.length >= 4) {
    redacted = redacted.split(apiKey).join("[key]");
    const runs = new Set(Array.from({ length: apiKey.length - 3 }, (_, index) => apiKey.slice(index, index + 4)));
    redacted = redacted.replace(ERROR_TEXT_TOKEN, (word) => {
      for (let index = 0; index + 4 <= word.length; index += 1) {
        if (runs.has(word.slice(index, index + 4))) return "[key]";
      }
      return word;
    });
  }
  redacted = redacted.replace(/\b(?:sk|pk|rk|key)-[A-Za-z0-9_*.-]{6,}/gu, "[key]");
  return redacted.slice(0, MAX_ERROR_LENGTH);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "The endpoint did not answer within 8 seconds.";
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
