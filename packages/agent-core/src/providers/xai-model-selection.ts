import type { LanguageModel } from "ai";
import type { XaiProvider } from "@ai-sdk/xai";

export const DEFAULT_GROK_MODEL = "grok-4.20-reasoning";
export const DEFAULT_GROK_SEARCH_MODEL = "grok-4.20-reasoning";

export type XaiModelMode = "chat" | "responses";

export function resolveGrokModel(model?: string): string {
  return model?.trim() || DEFAULT_GROK_MODEL;
}

export function selectGrokModelMode(model?: string): XaiModelMode {
  const modelId = resolveGrokModel(model);
  if (
    modelId === "grok-4" ||
    modelId.startsWith("grok-4.20") ||
    modelId.startsWith("grok-4-1") ||
    modelId.startsWith("grok-4-fast")
  ) {
    return "responses";
  }
  return "chat";
}

export function selectXaiModel(params: {
  provider: XaiProvider;
  model?: string;
  mode?: XaiModelMode;
}): LanguageModel {
  const modelId = resolveGrokModel(params.model);
  if (params.mode === "responses") {
    return params.provider.responses(modelId as never);
  }
  return params.provider(modelId as never);
}
