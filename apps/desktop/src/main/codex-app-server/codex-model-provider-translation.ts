import {
  formatCodexProviderModelId,
  parseCodexProviderModelId,
} from "@pwragent/shared";

/**
 * Translates PwrAgent's qualified model ids (`@provider/model`) at the Codex
 * wire.
 *
 * Outbound, a qualified id becomes Codex's `model` plus `modelProvider`. Codex
 * accepts `modelProvider` only when a thread starts, resumes or forks, so the
 * provider is fixed for the thread's life. Inbound, Codex reports a thread's
 * `modelProvider` beside its `model`, and the translator qualifies the model
 * again, so every PwrAgent surface sees one id per provider and model.
 *
 * Only providers PwrAgent configured are qualified. A thread on a provider
 * that the operator defined in their own Codex config keeps Codex's plain id.
 */
export class CodexModelProviderTranslator {
  private readonly threadProviders = new Map<string, string>();

  constructor(
    private readonly resolveProviderIds: () => ReadonlySet<string>,
    private readonly maxTrackedThreads = 5_000,
  ) {}

  /** The configured provider a thread runs on, when Codex has reported one. */
  providerForThread(threadId: string): string | undefined {
    const provider = this.threadProviders.get(threadId);
    return provider && this.resolveProviderIds().has(provider) ? provider : undefined;
  }

  /** Includes providers defined only in the operator's Codex profile. */
  reportedProviderForThread(threadId: string): string | undefined {
    return this.threadProviders.get(threadId);
  }

  /** Qualify a model Codex reported for a thread. */
  qualifyModel(threadId: string | undefined, model: string | undefined): string | undefined {
    if (!model || !threadId) return model;
    const provider = this.providerForThread(threadId);
    if (!provider || parseCodexProviderModelId(model).providerId) return model;
    return formatCodexProviderModelId(provider, model);
  }

  translateRequest(method: string, params: unknown): unknown {
    if (!isRecord(params) || !REQUEST_METHODS.has(method)) return params;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const requested = new Set<string>();
    const translated = stripModelIds(params, requested) as Record<string, unknown>;
    if (requested.size > 1) {
      throw new Error("A request named models from more than one model provider.");
    }
    const [requestedProvider] = requested;
    // A thread keeps its provider. Resume would otherwise re-pin it, and Codex
    // would send one provider's history to another. A fork is a new thread.
    // An unqualified model on a provider thread stays on that provider below.
    if (threadId && requestedProvider && THREAD_PROVIDER_METHODS.has(method)
      && this.threadProviders.has(threadId)) {
      const threadProvider = this.providerForThread(threadId);
      if (requestedProvider !== threadProvider) {
        throw new Error(`This thread runs on ${threadProvider ?? "Codex's default provider"}. `
          + `Hand it off to a new thread to use a ${requestedProvider} model.`);
      }
    }
    if (PROVIDER_PINNING_METHODS.has(method)) {
      const provider = requestedProvider ?? (method === "thread/start" ? undefined : this.providerForThread(threadId ?? ""));
      // A copy: the caller's params may be reused for a retry.
      return provider && translated.modelProvider === undefined
        ? { ...translated, modelProvider: provider }
        : translated;
    }
    return translated;
  }

  /** Learn thread providers from a response and qualify its models. */
  observeResponse(method: string, request: unknown, result: unknown): unknown {
    if (!isRecord(result)) return result;
    if (method === "thread/list" || method === "thread/loaded/list") {
      const data = Array.isArray(result.data) ? result.data : Array.isArray(result.threads) ? result.threads : undefined;
      if (!data) return result;
      const qualified = data.map((thread) => this.observeThread(thread));
      return Array.isArray(result.data) ? { ...result, data: qualified } : { ...result, threads: qualified };
    }
    if (!THREAD_RESULT_METHODS.has(method)) return result;
    let next = result;
    if (isRecord(result.thread)) {
      next = { ...next, thread: this.observeThread(result.thread) };
    }
    const threadId = isRecord(next.thread) && typeof next.thread.id === "string"
      ? next.thread.id
      : isRecord(request) && typeof request.threadId === "string" ? request.threadId : undefined;
    if (threadId && typeof result.modelProvider === "string") {
      this.remember(threadId, result.modelProvider);
    }
    if (threadId && typeof next.model === "string") {
      next = { ...next, model: this.qualifyModel(threadId, next.model) };
    }
    return next;
  }

  /** Qualify the models in a notification about a provider thread. */
  translateNotification(method: string, params: unknown): unknown {
    if (!isRecord(params)) return params;
    if (isRecord(params.thread)) {
      return { ...params, thread: this.observeThread(params.thread) };
    }
    if (!NOTIFICATION_METHODS.has(method)) return params;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const provider = threadId ? this.providerForThread(threadId) : undefined;
    return provider ? qualifyModelIds(params, provider) : params;
  }

  private observeThread(thread: unknown): unknown {
    if (!isRecord(thread) || typeof thread.id !== "string") return thread;
    if (typeof thread.modelProvider === "string") {
      this.remember(thread.id, thread.modelProvider);
    }
    const provider = this.providerForThread(thread.id);
    if (!provider || typeof thread.model !== "string" || parseCodexProviderModelId(thread.model).providerId) {
      return thread;
    }
    return { ...thread, model: formatCodexProviderModelId(provider, thread.model) };
  }

  /**
   * Every reported provider is kept, Codex's default included, so a request
   * can be checked against the thread's provider whichever it is.
   * `providerForThread` still answers only for configured providers.
   */
  private remember(threadId: string, provider: string): void {
    this.threadProviders.delete(threadId);
    this.threadProviders.set(threadId, provider);
    if (this.threadProviders.size > this.maxTrackedThreads) {
      const oldest = this.threadProviders.keys().next().value;
      if (oldest !== undefined) this.threadProviders.delete(oldest);
    }
  }
}

const PROVIDER_PINNING_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);
/** Requests that run on an existing thread, which keeps its provider. */
const THREAD_PROVIDER_METHODS = new Set(["thread/resume", "turn/start", "thread/settings/update"]);
const REQUEST_METHODS = new Set([
  ...PROVIDER_PINNING_METHODS,
  "turn/start",
  "thread/settings/update",
  "review/start",
]);
const THREAD_RESULT_METHODS = new Set(["thread/start", "thread/resume", "thread/fork", "thread/read"]);
const NOTIFICATION_METHODS = new Set([
  "thread/tokenUsage/updated",
  "thread/settings/updated",
  "turn/started",
  "turn/completed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Replace every qualified `model` value with Codex's id. Requests are small. */
function stripModelIds(value: unknown, providers: Set<string>, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => stripModelIds(item, providers, depth + 1));
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string") {
      const parsed = parseCodexProviderModelId(entry);
      if (parsed.providerId) {
        providers.add(parsed.providerId);
        next[key] = parsed.model;
        changed = true;
        continue;
      }
    }
    if (key === "input") {
      // Turn input is the operator's text; never rewrite it.
      next[key] = entry;
      continue;
    }
    const stripped = stripModelIds(entry, providers, depth + 1);
    if (stripped !== entry) changed = true;
    next[key] = stripped;
  }
  return changed ? next : value;
}

function qualifyModelIds(value: unknown, provider: string, depth = 0): unknown {
  if (depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => qualifyModelIds(item, provider, depth + 1));
  if (!isRecord(value)) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "model" && typeof entry === "string" && entry && !parseCodexProviderModelId(entry).providerId) {
      next[key] = formatCodexProviderModelId(provider, entry);
      changed = true;
      continue;
    }
    if (key === "items" || key === "input" || key === "output") {
      next[key] = entry;
      continue;
    }
    const qualified = qualifyModelIds(entry, provider, depth + 1);
    if (qualified !== entry) changed = true;
    next[key] = qualified;
  }
  return changed ? next : value;
}
