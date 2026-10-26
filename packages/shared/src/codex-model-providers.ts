/**
 * Model providers that Codex runs threads on besides its default provider.
 *
 * A provider is an OpenAI Responses-compatible endpoint (Refuseless, a second
 * OpenAI API key, a local llama.cpp server). PwrAgent gives it to the single
 * Codex App Server as a `model_providers.<id>` table and pins a thread to it
 * with `thread/start.modelProvider`. Codex then reports `Thread.modelProvider`
 * on every read.
 *
 * Every PwrAgent surface names one of these models with a qualified id,
 * `@<provider>/<model>`. Codex model ids never start with `@`, so the prefix
 * cannot collide with an id Codex reports itself. The Codex adapter strips the
 * prefix before a request and adds it back to what Codex reports.
 */

import type { ThreadUsageLineRecord } from "./token-usage-pricing";

// This package compiles without DOM or Node types. Every runtime it ships to
// (Electron main, renderer, Node tests) has the WHATWG URL global.
type ParsedUrl = {
  protocol: string;
  hostname: string;
  username: string;
  password: string;
  search: string;
  hash: string;
  toString(): string;
};
declare const URL: new (input: string) => ParsedUrl;

export type CodexModelProviderRate = {
  /** Exact upstream model id, without the `@provider/` prefix. */
  model: string;
  /** USD per 1M uncached input tokens. */
  inputPerMillion?: number;
  /** USD per 1M output tokens, reasoning included. */
  outputPerMillion?: number;
  /** USD per 1M cached input tokens. Falls back to the input rate. */
  cachedInputPerMillion?: number;
};

export type CodexModelProviderSettings = {
  /** Codex `model_providers` key and model-id prefix. */
  id: string;
  /** Display name, such as `Refuseless`. */
  name: string;
  /** Responses API base URL, such as `https://api.example.com/v1`. */
  baseUrl: string;
  /** Model ids served by the endpoint. Merged with discovered ones. */
  models?: string[];
  /** Read `GET {baseUrl}/models` for more model ids. Defaults to true. */
  discoverModels?: boolean;
  /** Declared to cost nothing, as for a local server. Overrides rates. */
  local?: boolean;
  rates?: CodexModelProviderRate[];
};

/** Settings snapshot form: whether a key is stored, never the key. */
export type DesktopCodexModelProvider = CodexModelProviderSettings & {
  hasApiKey: boolean;
};

/** What Settings shows after Test connection. */
export type CodexModelProviderTestResult = {
  /** `GET /models`. */
  models: { ok: boolean; count: number; error?: string };
  /** One short `POST /responses`, the only wire format Codex speaks. */
  responses: { ok: boolean; model?: string; skipped?: boolean; error?: string };
  latencyMs?: number;
};

export const CODEX_MODEL_PROVIDER_LIMIT = 16;
export const CODEX_MODEL_PROVIDER_MODEL_LIMIT = 64;

/** Ledger provider ids and Codex built-in provider ids a provider cannot take. */
export const RESERVED_CODEX_MODEL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "amazon-bedrock",
  "azure",
  "codex",
  "default",
  "google",
  "local",
  "lmstudio",
  "ollama",
  "oss",
  "qwen",
  "xai",
]);

const PROVIDER_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const QUALIFIED_MODEL_ID = /^@([a-z][a-z0-9_-]{0,31})\/(.+)$/s;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_RATE_PER_MILLION = 10_000;

export function isValidCodexModelProviderId(value: string): boolean {
  return PROVIDER_ID.test(value) && !RESERVED_CODEX_MODEL_PROVIDER_IDS.has(value);
}

export function formatCodexProviderModelId(providerId: string, model: string): string {
  return `@${providerId}/${model}`;
}

/**
 * Split a model id PwrAgent surfaces carry. An unqualified id belongs to
 * Codex's default provider and comes back as `{ model }`.
 */
export function parseCodexProviderModelId(value: string): {
  providerId?: string;
  model: string;
} {
  const match = QUALIFIED_MODEL_ID.exec(value);
  return match ? { providerId: match[1], model: match[2] } : { model: value };
}

export function codexProviderIdOfModel(value: string | undefined): string | undefined {
  return value ? parseCodexProviderModelId(value).providerId : undefined;
}

/**
 * The environment variable that carries a provider's API key into Codex.
 * Codex reads it for its own requests. Its shell environment policy passes
 * `*KEY*` variables to commands by default, so
 * `buildCodexModelProviderShellEnvOverrides` blanks it for them.
 */
export function codexModelProviderApiKeyEnv(providerId: string): string {
  return `PWRAGENT_CODEX_PROVIDER_${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

function validateModelId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  const model = value.trim();
  if (!model || model.length > MAX_MODEL_ID_LENGTH || /[\0\r\n]/.test(model) || model.startsWith("@")) {
    throw new Error(`${field} must be a nonempty model id that does not start with @.`);
  }
  return model;
}

function validateRate(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_RATE_PER_MILLION) {
    throw new Error(`${field} must be a number from 0 to ${MAX_RATE_PER_MILLION}.`);
  }
  return value;
}

/** Throws on anything Codex or the ledger could misread. */
export function validateCodexBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("A model provider needs a base URL.");
  }
  let url: ParsedUrl;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The base URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The base URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Put the API key in the key field, not in the base URL.");
  }
  if (url.search || url.hash) {
    throw new Error("The base URL cannot have a query string or fragment.");
  }
  return url.toString().replace(/\/+$/, "");
}

export function validateCodexModelProviders(value: unknown): CodexModelProviderSettings[] {
  if (!Array.isArray(value) || value.length > CODEX_MODEL_PROVIDER_LIMIT) {
    throw new Error(`models.codex.providers must be a list of at most ${CODEX_MODEL_PROVIDER_LIMIT} providers.`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const entry = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
    const label = `models.codex.providers[${index}]`;
    if (!entry) throw new Error(`${label} must be a table.`);
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!isValidCodexModelProviderId(id)) {
      throw new Error(`${label}.id must be lowercase letters, digits, _ or -, start with a letter, and not be a reserved provider id.`);
    }
    if (seen.has(id)) throw new Error(`${label}.id "${id}" is used twice.`);
    seen.add(id);
    const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim().slice(0, 60) : id;
    const baseUrl = validateCodexBaseUrl(entry.baseUrl);
    const models = entry.models === undefined
      ? undefined
      : Array.isArray(entry.models) && entry.models.length <= CODEX_MODEL_PROVIDER_MODEL_LIMIT
        ? [...new Set(entry.models.map((model, modelIndex) =>
            validateModelId(model, `${label}.models[${modelIndex}]`)))]
        : (() => {
            throw new Error(`${label}.models must be a list of at most ${CODEX_MODEL_PROVIDER_MODEL_LIMIT} ids.`);
          })();
    const rates = entry.rates === undefined
      ? undefined
      : Array.isArray(entry.rates) && entry.rates.length <= CODEX_MODEL_PROVIDER_MODEL_LIMIT
        ? entry.rates.map((rawRate, rateIndex): CodexModelProviderRate => {
            const rate = rawRate && typeof rawRate === "object" ? rawRate as Record<string, unknown> : {};
            const field = `${label}.rates[${rateIndex}]`;
            const inputPerMillion = validateRate(rate.inputPerMillion, `${field}.input`);
            const outputPerMillion = validateRate(rate.outputPerMillion, `${field}.output`);
            const cachedInputPerMillion = validateRate(rate.cachedInputPerMillion, `${field}.cached_input`);
            return {
              model: validateModelId(rate.model, `${field}.model`),
              ...(inputPerMillion === undefined ? {} : { inputPerMillion }),
              ...(outputPerMillion === undefined ? {} : { outputPerMillion }),
              ...(cachedInputPerMillion === undefined ? {} : { cachedInputPerMillion }),
            };
          })
        : (() => {
            throw new Error(`${label}.rates must be a list of at most ${CODEX_MODEL_PROVIDER_MODEL_LIMIT} rates.`);
          })();
    return {
      id,
      name,
      baseUrl,
      ...(models ? { models } : {}),
      ...(typeof entry.discoverModels === "boolean" ? { discoverModels: entry.discoverModels } : {}),
      ...(entry.local === true ? { local: true } : {}),
      ...(rates?.length ? { rates } : {}),
    };
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Process-level `-c` overrides that define each provider for Codex. Keys are
 * passed by environment variable, never as an argument, because process
 * arguments are visible to every local user.
 */
export function buildCodexModelProviderConfigOverrides(
  providers: readonly CodexModelProviderSettings[],
  providerIdsWithKeys: ReadonlySet<string>,
): string[] {
  return providers.flatMap((provider) => {
    const prefix = `model_providers.${provider.id}`;
    return [
      `${prefix}.name=${tomlString(provider.name)}`,
      `${prefix}.base_url=${tomlString(provider.baseUrl)}`,
      `${prefix}.wire_api="responses"`,
      `${prefix}.requires_openai_auth=false`,
      ...(providerIdsWithKeys.has(provider.id)
        ? [`${prefix}.env_key=${tomlString(codexModelProviderApiKeyEnv(provider.id))}`]
        : []),
    ];
  });
}

/**
 * Overrides that blank each provider key for the commands a model runs.
 * Codex passes `*KEY*` variables to them by default
 * (`ignore_default_excludes = true`). A dotted `set` entry leaves the
 * operator's own `set` table as it is. Pass these after the operator's
 * overrides, so none of those can restore a key.
 */
export function buildCodexModelProviderShellEnvOverrides(
  providerIdsWithKeys: Iterable<string>,
): string[] {
  return [...providerIdsWithKeys].map((id) =>
    `shell_environment_policy.set.${codexModelProviderApiKeyEnv(id)}=""`);
}

export function findCodexModelProviderRate(
  provider: CodexModelProviderSettings,
  model: string,
): CodexModelProviderRate | undefined {
  return provider.rates?.find((rate) => rate.model === model);
}

export const CODEX_MODEL_PROVIDER_PRICING_CATALOG = "codex-model-provider";

/**
 * Re-attribute one Codex usage line to the provider its thread ran on.
 *
 * The Codex adapter writes every line as OpenAI's and prices it from the
 * OpenAI catalog by model id. A provider's line must instead carry the
 * provider, its own account and its own rates. Without a rate it is unpriced,
 * never priced at an OpenAI rate that happens to share the model id.
 */
export function attributeCodexProviderUsageLine<T extends ThreadUsageLineRecord>(
  line: T,
  provider: CodexModelProviderSettings,
  accountKey: string | undefined,
): T {
  const upstreamModel = line.model ? parseCodexProviderModelId(line.model).model : undefined;
  const { priceUnavailableReason: _previousReason, accountKey: _previousAccount, ...rest } = line;
  const base = {
    ...rest,
    provider: provider.id,
    ...(accountKey ? { accountKey } : {}),
    ...(upstreamModel ? { model: formatCodexProviderModelId(provider.id, upstreamModel) } : {}),
    currency: "USD",
    pricingCatalogId: CODEX_MODEL_PROVIDER_PRICING_CATALOG,
    pricingCatalogVersion: "1",
  };
  const rate = upstreamModel ? findCodexModelProviderRate(provider, upstreamModel) : undefined;
  // Only OpenAI's own API is billed at OpenAI catalog rates, so only there
  // can the adapter's catalog price stand when no rate was entered.
  if (!provider.local && !rate && isOpenAiApiBaseUrl(provider.baseUrl) && line.priceStatus === "priced") {
    return {
      ...base,
      pricingCatalogId: line.pricingCatalogId,
      pricingCatalogVersion: line.pricingCatalogVersion,
      currency: line.currency,
    } as T;
  }
  const uncachedRate = provider.local ? 0 : rate?.inputPerMillion;
  const outputRate = provider.local ? 0 : rate?.outputPerMillion;
  const cachedRate = provider.local ? 0 : rate?.cachedInputPerMillion ?? rate?.inputPerMillion;
  if (uncachedRate === undefined || outputRate === undefined || cachedRate === undefined) {
    const { cumulativeTotalCostMicros: _cumulative, ...unpriced } = base;
    return {
      ...unpriced,
      priceStatus: "unpriced",
      priceUnavailableReason: upstreamModel ? "missing-rate" : "missing-model",
      cacheWriteInputCostMicros: 0,
      cachedInputCostMicros: 0,
      uncachedInputCostMicros: 0,
      outputCostMicros: 0,
      totalCostMicros: 0,
      ...(upstreamModel ? { pricingRateId: `${provider.id}:${upstreamModel}` } : {}),
    } as T;
  }
  // USD per 1M tokens is exactly micro-USD per token.
  const cost = (uncached: number, cached: number, output: number): number =>
    Math.round(uncached * uncachedRate) + Math.round(cached * cachedRate) + Math.round(output * outputRate);
  const uncachedInputCostMicros = Math.round(line.uncachedInputTokens * uncachedRate);
  const cachedInputCostMicros = Math.round(line.cachedInputTokens * cachedRate);
  const outputCostMicros = Math.round((line.outputTokens + line.reasoningOutputTokens) * outputRate);
  const totalCostMicros = uncachedInputCostMicros + cachedInputCostMicros + outputCostMicros;
  const { cumulativeTotalCostMicros: _cumulative, ...priced } = base;
  const cumulativeTotalCostMicros =
    line.cumulativeUncachedInputTokens !== undefined
    && line.cumulativeCachedInputTokens !== undefined
    && line.cumulativeOutputTokens !== undefined
      ? cost(
          line.cumulativeUncachedInputTokens,
          line.cumulativeCachedInputTokens,
          line.cumulativeOutputTokens + (line.cumulativeReasoningOutputTokens ?? 0),
        )
      : undefined;
  return {
    ...priced,
    priceStatus: "priced",
    pricingRateId: provider.local ? `${provider.id}:local` : `${provider.id}:${upstreamModel}`,
    cacheWriteInputCostMicros: 0,
    cachedInputCostMicros,
    uncachedInputCostMicros,
    outputCostMicros,
    totalCostMicros,
    ...(cumulativeTotalCostMicros === undefined ? {} : { cumulativeTotalCostMicros }),
  } as T;
}

/** `api.openai.com` itself, the one endpoint OpenAI catalog prices describe. */
export function isOpenAiApiBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function normalizeModelReference(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Resolve a model an Agent or person named to one option id. The exact id
 * always wins. Otherwise a name such as `Refuseless / GLM-5.3 abliterated`
 * matches when it equals one option's provider plus model, or its model
 * alone, compared without case, spaces or punctuation. A name that fits
 * several options matches none.
 */
export function resolveModelOptionReference<T extends {
  id: string;
  label?: string;
  providerId?: string;
  providerLabel?: string;
}>(options: readonly T[], reference: string): { id?: string; candidates: T[] } {
  const exact = options.find((option) => option.id === reference);
  if (exact) return { id: exact.id, candidates: [exact] };
  const wanted = normalizeModelReference(reference);
  if (!wanted) return { candidates: [] };
  const matches = options.filter((option) => {
    const upstream = parseCodexProviderModelId(option.id).model;
    const names = [option.label, upstream].filter((name): name is string => Boolean(name));
    const providers = [option.providerLabel, option.providerId].filter((name): name is string => Boolean(name));
    // A bare model name counts too, so "glm-5.3-abliterated" finds the one
    // provider that serves it; two providers serving it make it ambiguous.
    const forms = [...names, ...providers.flatMap((provider) => names.map((name) => `${provider}${name}`))];
    return forms.some((form) => normalizeModelReference(form) === wanted);
  });
  return matches.length === 1 ? { id: matches[0].id, candidates: matches } : { candidates: matches };
}

/** A model's name with its provider when it is not Codex's default one. */
export function formatModelOptionLabel(option: {
  id: string;
  label?: string;
  providerLabel?: string;
}): string {
  const name = option.label ?? parseCodexProviderModelId(option.id).model;
  return option.providerLabel ? `${option.providerLabel} · ${name}` : name;
}

/**
 * The models an existing thread may switch to. Codex fixes a thread's model
 * provider when it starts, so only that provider's models qualify.
 */
export function modelOptionsForThreadProvider<T extends { id: string }>(
  options: readonly T[],
  threadModel: string | undefined,
): T[] {
  const provider = codexProviderIdOfModel(threadModel);
  return options.filter((option) => codexProviderIdOfModel(option.id) === provider);
}
