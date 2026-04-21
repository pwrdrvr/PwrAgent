import type { LanguageModel } from "ai";
import type { XaiProvider } from "@ai-sdk/xai";

export const DEFAULT_GROK_MODEL = "grok-4.20-reasoning";
export const DEFAULT_GROK_SEARCH_MODEL = "grok-4-1-fast-non-reasoning";

export function resolveGrokModel(model?: string): string {
  return model?.trim() || DEFAULT_GROK_MODEL;
}

export function selectXaiModel(params: {
  provider: XaiProvider;
  model?: string;
}): LanguageModel {
  const modelId = resolveGrokModel(params.model);
  return params.provider.responses(modelId as never);
}
