import { createXai } from "@ai-sdk/xai";
import { generateObject, jsonSchema } from "ai";
import { DEFAULT_GROK_MODEL } from "./xai-model-selection.js";

export type XaiAiSdkObjectClientOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  model?: string;
};

export type XaiAiSdkObjectRequest = {
  model?: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  schemaName?: string;
  headers?: Record<string, string>;
  promptCacheKey?: string;
  signal?: AbortSignal;
};

export type XaiAiSdkObjectResult = {
  object: unknown;
  cachedTokens?: number;
};

export class XaiAiSdkObjectClient {
  private readonly apiKey: string;
  private readonly baseUrl?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers?: Record<string, string>;
  private readonly defaultModel?: string;

  constructor(options: XaiAiSdkObjectClientOptions) {
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) {
      throw new Error("xAI API key is required");
    }
    this.baseUrl = options.baseUrl?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.headers = options.headers;
    this.defaultModel = options.model?.trim() || undefined;
  }

  async generateObject(params: XaiAiSdkObjectRequest): Promise<XaiAiSdkObjectResult> {
    const provider = createXai({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      headers: this.headers,
      fetch: createPromptCacheFetch(this.fetchImpl, params.promptCacheKey),
    });
    const result = await generateObject({
      model: provider.responses(params.model?.trim() || this.defaultModel || DEFAULT_GROK_MODEL),
      system: params.system,
      prompt: params.prompt,
      schema: jsonSchema(params.schema as Parameters<typeof jsonSchema>[0]),
      schemaName: params.schemaName,
      headers: params.headers,
      abortSignal: params.signal,
      maxRetries: 0,
    });

    return {
      object: result.object,
      cachedTokens: result.usage.inputTokenDetails.cacheReadTokens,
    };
  }
}

function createPromptCacheFetch(
  fetchImpl: typeof fetch,
  promptCacheKey: string | undefined,
): typeof fetch {
  const trimmedPromptCacheKey = promptCacheKey?.trim();
  if (!trimmedPromptCacheKey) {
    return fetchImpl;
  }

  return (async (input, init) => {
    if (!isResponsesRequest(input) || typeof init?.body !== "string") {
      return await fetchImpl(input, init);
    }

    const body = tryInjectPromptCacheKey(init.body, trimmedPromptCacheKey);
    return await fetchImpl(input, body === init.body ? init : { ...init, body });
  }) as typeof fetch;
}

function isResponsesRequest(input: Parameters<typeof fetch>[0]): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : typeof input === "object" &&
            input !== null &&
            "url" in input &&
            typeof input.url === "string"
          ? input.url
          : "";
  return url.endsWith("/responses");
}

function tryInjectPromptCacheKey(body: string, promptCacheKey: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return body;
    }
    return JSON.stringify({
      ...parsed,
      prompt_cache_key: promptCacheKey,
    });
  } catch {
    return body;
  }
}
