import type { AppServerThreadSummary } from "./contracts/normalized-app-server";

export type ThreadContextWindowReading = NonNullable<AppServerThreadSummary["contextWindow"]>;

export function threadContextWindowReading(totalTokens: unknown, modelContextWindow: unknown): ThreadContextWindowReading | undefined {
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0
    || typeof modelContextWindow !== "number" || !Number.isFinite(modelContextWindow) || modelContextWindow <= 0) return undefined;
  return { totalTokens, modelContextWindow };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function finiteNumber(record: Record<string, unknown> | undefined, names: readonly string[]): number | undefined {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Only the last model request describes context fill. The total spans requests. */
export function readCodexContextWindow(tokenUsage: unknown): ThreadContextWindowReading | undefined {
  const envelope = record(tokenUsage);
  const root = record(envelope?.tokenUsage) ?? envelope;
  const last = record(root?.last) ?? record(root?.last_token_usage);
  return threadContextWindowReading(
    finiteNumber(last, ["totalTokens", "total_tokens"]),
    finiteNumber(root, ["modelContextWindow", "model_context_window"]),
  );
}
