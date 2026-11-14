import {
  formatCodexProviderModelId,
  type BackendModelOption,
  type CodexModelProviderCatalogState,
  type CodexModelProviderSettings,
  type CodexModelProviderTestResult,
} from "@pwragent/shared";
import { prepareBonsaiRuntime } from "../codex-app-server/bonsai-runtime";

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

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type DiscoveredModel = { id: string; label?: string };

type Discovery = {
  models: DiscoveredModel[];
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
  }) {}

  invalidate(): void {
    this.discovery.clear();
  }

  async listModelOptions(): Promise<BackendModelOption[]> {
    const providers = this.options.resolveProviders();
    if (providers.length === 0) return [];
    const keys = await this.options.resolveKeys().catch((): Record<string, string> => ({}));
    const perProvider = await Promise.all(providers.map(async (provider) => {
      const discovered = provider.discoverModels === false
        ? []
        : (await this.discover(provider, keys[provider.id])).discovery?.models ?? [];
      const labels = new Map(discovered.map((model) => [model.id, model.label]));
      const ids = [...new Set([...(provider.models ?? []), ...discovered.map((model) => model.id)])];
      return ids.map((model): BackendModelOption => ({
        id: formatCodexProviderModelId(provider.id, model),
        label: labels.get(model) || model,
        providerId: provider.id,
        providerLabel: provider.name,
        // Codex sends reasoning settings only for models in its own catalog.
        // A provider model takes the endpoint's defaults.
        supportsReasoning: false,
        supportsFast: false,
      }));
    }));
    return perProvider.flat();
  }

  /**
   * What each configured provider's last catalog read found, in configured
   * order. It never reads an endpoint itself; `listModelOptions` does.
   */
  catalogStates(): CodexModelProviderCatalogState[] {
    return this.options.resolveProviders().map((provider): CodexModelProviderCatalogState => {
      const base = { id: provider.id, name: provider.name, listedCount: provider.models?.length ?? 0 };
      if (provider.discoverModels === false) return { ...base, status: "off" };
      const state = this.discovery.get(provider.id);
      // A read of a base URL the provider no longer has says nothing about it.
      if (!state?.fingerprint.startsWith(`${provider.baseUrl}\u0000`)) {
        return { ...base, status: "pending" };
      }
      if (state.error !== undefined) return { ...base, status: "unavailable", error: state.error };
      if (!state.discovery) return { ...base, status: "pending" };
      return {
        ...base,
        status: "ready",
        discoveredCount: state.discovery.models.length,
        ...(state.discovery.truncated ? { truncated: true } : {}),
      };
    });
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
    const models: DiscoveredModel[] = [];
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
        if (!id || id.length > 256 || id.startsWith("@") || /[\0\r\n]/.test(id) || seen.has(id)) continue;
        if (models.length >= MAX_DISCOVERED_MODELS) return { models, truncated: true, pages };
        seen.add(id);
        const name = typeof item?.name === "string" ? item.name.trim().slice(0, 120) : undefined;
        models.push({ id, ...(name && name !== id ? { label: name } : {}) });
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
    let models: DiscoveredModel[] = [];
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
        models: modelsTestResult(models.length, modelPages, modelsError),
        responses: { ok: false, skipped: true, error: "No model to try. List one, or let the endpoint list its models." },
        latencyMs: reachedAfterMs,
      };
    }
    let responsesError: string | undefined;
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
    } catch (error) {
      responsesError = redactSecret(errorMessage(error), apiKey);
    } finally {
      await runtime?.close();
    }
    return {
      models: modelsTestResult(models.length, modelPages, modelsError),
      responses: { ok: !responsesError, model: probeModel, ...(responsesError ? { error: responsesError } : {}) },
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
  count: number,
  pages: Pick<Discovery, "pages" | "truncated"> | undefined,
  error: string | undefined,
): CodexModelProviderTestResult["models"] {
  return {
    ok: !error,
    count,
    ...(pages && pages.pages > 1 ? { pages: pages.pages } : {}),
    ...(pages?.truncated ? { truncated: true } : {}),
    ...(error ? { error } : {}),
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
