import { createXai, type XaiProvider } from "@ai-sdk/xai";
import { generateText, streamText, type LanguageModel } from "ai";
import { DEFAULT_GROK_SEARCH_MODEL, selectXaiModel } from "./xai-model-selection.js";

export type XaiAiSdkRuntimeOptions = {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  headers?: Record<string, string>;
  model?: string;
  searchModel?: string;
  searchToolTimeoutMs?: number;
  provider?: XaiProvider;
  streamTextImpl?: (params: Record<string, unknown>) => unknown;
  generateTextImpl?: (params: Record<string, unknown>) => Promise<unknown>;
};

export const DEFAULT_XAI_SEARCH_TOOL_TIMEOUT_MS = 90_000;

export class XaiAiSdkRuntime {
  readonly provider: XaiProvider;
  readonly searchToolTimeoutMs: number;
  private readonly defaultModel?: string;
  private readonly defaultSearchModel?: string;
  private readonly streamTextImpl: (params: Record<string, unknown>) => unknown;
  private readonly generateTextImpl: (params: Record<string, unknown>) => Promise<unknown>;

  constructor(options: XaiAiSdkRuntimeOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("xAI API key is required");
    }
    this.defaultModel = options.model?.trim() || undefined;
    this.defaultSearchModel = options.searchModel?.trim() || undefined;
    this.searchToolTimeoutMs =
      Number.isFinite(options.searchToolTimeoutMs) &&
      options.searchToolTimeoutMs !== undefined
        ? Math.max(0, options.searchToolTimeoutMs)
        : DEFAULT_XAI_SEARCH_TOOL_TIMEOUT_MS;
    this.provider =
      options.provider ??
      createXai({
        apiKey,
        baseURL: options.baseUrl?.trim() || undefined,
        headers: options.headers,
        fetch: options.fetchImpl,
      });
    this.streamTextImpl = options.streamTextImpl ?? ((params) => streamText(params as never));
    this.generateTextImpl =
      options.generateTextImpl ?? (async (params) => await generateText(params as never));
  }

  model(params?: { model?: string }): LanguageModel {
    return selectXaiModel({
      provider: this.provider,
      model: params?.model ?? this.defaultModel,
    });
  }

  searchModel(model?: string): LanguageModel {
    return selectXaiModel({
      provider: this.provider,
      model: model?.trim() || this.defaultSearchModel || DEFAULT_GROK_SEARCH_MODEL,
    });
  }

  streamText(params: Record<string, unknown>): unknown {
    return this.streamTextImpl(params);
  }

  async generateText(params: Record<string, unknown>): Promise<unknown> {
    return await this.generateTextImpl(params);
  }
}

export function buildXaiProviderOptions(params: {
  model?: string;
  reasoningEffort?: string;
  previousResponseId?: string;
}): Record<string, Record<string, unknown>> | undefined {
  const xaiOptions: Record<string, unknown> = {};
  const reasoningEffort = normalizeReasoningEffort(
    params.reasoningEffort,
    params.model,
  );
  if (reasoningEffort) {
    xaiOptions.reasoningEffort = reasoningEffort;
  }
  if (params.previousResponseId?.trim()) {
    xaiOptions.previousResponseId = params.previousResponseId.trim();
  }
  return Object.keys(xaiOptions).length > 0 ? { xai: xaiOptions } : undefined;
}

function normalizeReasoningEffort(
  value: string | undefined,
  model?: string,
): string | undefined {
  const effort = value?.trim();
  if (!effort) {
    return undefined;
  }
  if (!supportsReasoningEffort(model)) {
    return undefined;
  }
  return ["low", "medium", "high"].includes(effort) ? effort : undefined;
}

function supportsReasoningEffort(model?: string): boolean {
  return model?.trim().includes("multi-agent") ?? false;
}
