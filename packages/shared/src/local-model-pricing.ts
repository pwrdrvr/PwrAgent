import type { ThreadUsageLineRecord } from "./token-usage-pricing";
import { parseCodexProviderModelId } from "./codex-model-providers";

export const LOCAL_MODEL_PRICING_CATALOG = "local-inference";

/** Explicit profile declaration, never inferred from a model name or endpoint. */
export function validateLocalModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 128
    || value.some((id) => typeof id !== "string" || !id.trim() || id.length > 4096 || /[\0\r\n]/.test(id))) {
    throw new Error("models.codex.local_model_ids must be an array of at most 128 nonempty model IDs.");
  }
  return [...new Set(value.map((id: string) => id.trim()))];
}

/** Display only: preserve the protocol ID separately for accounting and requests. */
export function formatPricingModelLabel(model?: string, label?: string): string {
  const display = label?.trim() ? label : model;
  if (!display) return "Unknown model";
  const upstream = parseCodexProviderModelId(display).model;
  if (/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(upstream)) {
    return upstream.split(/[\\/]/).filter(Boolean).at(-1) ?? display;
  }
  return display;
}

/** Reversible read projection: never rewrite historical usage or token counts. */
export function priceLocalModelUsage<T extends ThreadUsageLineRecord>(line: T): T {
  const { priceUnavailableReason: _reason, ...rest } = line;
  return {
    ...rest,
    provider: "local",
    currency: "USD",
    priceStatus: "priced",
    pricingCatalogId: LOCAL_MODEL_PRICING_CATALOG,
    pricingCatalogVersion: "1",
    pricingRateId: "local-inference:zero",
    cacheWriteInputCostMicros: 0,
    cachedInputCostMicros: 0,
    uncachedInputCostMicros: 0,
    outputCostMicros: 0,
    totalCostMicros: 0,
    ...(line.cumulativeTotalCostMicros === undefined ? {} : { cumulativeTotalCostMicros: 0 }),
  } as T;
}
