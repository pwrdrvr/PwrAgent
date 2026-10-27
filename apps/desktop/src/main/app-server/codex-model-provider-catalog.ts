import {
  formatCodexProviderModelId,
  type BackendModelOption,
  type CodexModelProviderSettings,
  type CodexModelProviderTestResult,
} from "@pwragent/shared";
import { prepareBonsaiRuntime } from "../codex-app-server/bonsai-runtime";

const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_FAILURE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 200;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type DiscoveryState = {
  fingerprint: string;
  expiresAt: number;
  models: Array<{ id: string; label?: string }>;
  promise?: Promise<Array<{ id: string; label?: string }>>;
};

/**
 * Model ids for each Codex model provider, as model options for the `codex`
 * backend. Every surface that lists Codex models (the composer, federation
 * peers, messaging pickers and the Agent tools) reads them from there.
 *
 * Discovery reads the provider's OpenAI-compatible `GET /models`. It is
 * bounded: one request per provider per ten minutes, an eight-second timeout,
 * a 1 MiB response, no redirects. A failed read falls back to the ids the
 * operator listed, so a provider that is down still shows its known models.
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
        : await this.discover(provider, keys[provider.id]).catch(() => []);
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

  private async discover(
    provider: CodexModelProviderSettings,
    apiKey: string | undefined,
  ): Promise<Array<{ id: string; label?: string }>> {
    const now = this.options.now?.() ?? Date.now();
    const fingerprint = `${provider.baseUrl}\u0000${apiKey ? "key" : ""}`;
    const cached = this.discovery.get(provider.id);
    if (cached?.fingerprint === fingerprint) {
      if (cached.promise) return await cached.promise;
      if (cached.expiresAt > now) return cached.models;
    }
    const state: DiscoveryState = { fingerprint, expiresAt: 0, models: cached?.models ?? [] };
    state.promise = this.fetchModels(provider.baseUrl, apiKey)
      .then((models) => {
        state.models = models;
        state.expiresAt = now + DISCOVERY_TTL_MS;
        return models;
      })
      .catch((error: unknown) => {
        state.expiresAt = now + DISCOVERY_FAILURE_TTL_MS;
        throw error;
      })
      .finally(() => {
        state.promise = undefined;
      });
    this.discovery.set(provider.id, state);
    return await state.promise;
  }

  private async fetchModels(
    baseUrl: string,
    apiKey: string | undefined,
  ): Promise<Array<{ id: string; label?: string }>> {
    const body = await this.requestJson(`${baseUrl}/models`, { method: "GET" }, apiKey);
    const data = body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : Array.isArray(body) ? body : [];
    const models: Array<{ id: string; label?: string }> = [];
    for (const entry of data) {
      const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
      const id = typeof record?.id === "string" ? record.id.trim() : "";
      if (!id || id.length > 256 || id.startsWith("@") || /[\0\r\n]/.test(id)) continue;
      const name = typeof record?.name === "string" ? record.name.trim().slice(0, 120) : undefined;
      models.push({ id, ...(name && name !== id ? { label: name } : {}) });
      if (models.length >= MAX_DISCOVERED_MODELS) break;
    }
    return models;
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
    let models: Array<{ id: string; label?: string }> = [];
    let modelsError: string | undefined;
    try {
      models = await this.fetchModels(provider.baseUrl, apiKey);
    } catch (error) {
      modelsError = errorMessage(error);
    }
    const reachedAfterMs = (this.options.now?.() ?? Date.now()) - startedAt;
    const probeModel = provider.models?.[0] ?? models[0]?.id;
    if (!probeModel) {
      return {
        models: { ok: !modelsError, count: models.length, ...(modelsError ? { error: modelsError } : {}) },
        responses: { ok: false, skipped: true, error: "No model to try. List one, or let the endpoint list its models." },
        latencyMs: reachedAfterMs,
      };
    }
    let responsesError: string | undefined;
    let runtime: Awaited<ReturnType<typeof prepareBonsaiRuntime>> | undefined;
    try {
      if (provider.compatibility === "bonsai") {
        runtime = await (this.options.prepareCompatibility ?? prepareBonsaiRuntime)(provider);
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
      responsesError = errorMessage(error);
    } finally {
      await runtime?.close();
    }
    return {
      models: { ok: !modelsError, count: models.length, ...(modelsError ? { error: modelsError } : {}) },
      responses: { ok: !responsesError, model: probeModel, ...(responsesError ? { error: responsesError } : {}) },
      latencyMs: reachedAfterMs,
    };
  }

  private async requestJson(url: string, init: RequestInit, apiKey: string | undefined): Promise<unknown> {
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
      const text = await readBoundedText(response);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}${describeErrorBody(text)}`);
      }
      return text ? JSON.parse(text) as unknown : undefined;
    } finally {
      clearTimeout(timer);
    }
  }
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

async function readBoundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > MAX_RESPONSE_BYTES) throw new Error("The response was larger than 1 MiB.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("The response was larger than 1 MiB.");
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

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "The endpoint did not answer within 8 seconds.";
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}
