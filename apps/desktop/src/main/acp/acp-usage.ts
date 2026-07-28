import type { BackendAcpSessionRuntimeState } from "@pwragent/shared";

export type AcpTokenUsage = {
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

export type AcpUsageEnvelope = {
  model?: string;
  scope: "model-call" | "turn";
  tokenUsage: AcpTokenUsage;
};

export function readAcpUsageEnvelope(
  update: Record<string, unknown>,
): AcpUsageEnvelope | undefined {
  const kind = readAcpUpdateKind(update);
  const usage =
    kind === "turn_completed"
      ? readRecord(update.usage)
      : kind === "agent_message_chunk"
        ? readRecord(readRecord(update._meta)?.usage)
        : undefined;
  if (!usage) {
    return undefined;
  }

  const inputTokens = readFiniteNumber(usage.inputTokens);
  const cachedInputTokens =
    readFiniteNumber(usage.cachedInputTokens) ??
    readFiniteNumber(usage.cachedReadTokens);
  const outputTokens = readFiniteNumber(usage.outputTokens);
  const reasoningOutputTokens =
    readFiniteNumber(usage.reasoningOutputTokens) ??
    readFiniteNumber(usage.reasoningTokens) ??
    readFiniteNumber(usage.thoughtTokens);
  const totalTokens = readFiniteNumber(usage.totalTokens);
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }

  const modelUsage = readRecord(usage.modelUsage);
  const model =
    readNonEmptyString(usage.model) ??
    readNonEmptyString(usage.modelId) ??
    readNonEmptyString(usage.model_id) ??
    (modelUsage ? Object.keys(modelUsage)[0] : undefined);
  return {
    ...(model ? { model } : {}),
    scope: kind === "turn_completed" ? "turn" : "model-call",
    tokenUsage: {
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens }
        : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
    },
  };
}

export function foldAcpTurnUsage(
  previous: AcpTokenUsage | undefined,
  envelope: AcpUsageEnvelope,
): AcpTokenUsage {
  if (envelope.scope === "turn") {
    return envelope.tokenUsage;
  }
  if (!previous) {
    return envelope.tokenUsage;
  }
  return {
    ...sumPresentUsageField(previous, envelope.tokenUsage, "cachedInputTokens"),
    ...sumPresentUsageField(previous, envelope.tokenUsage, "inputTokens"),
    ...sumPresentUsageField(previous, envelope.tokenUsage, "outputTokens"),
    ...sumPresentUsageField(previous, envelope.tokenUsage, "reasoningOutputTokens"),
    ...sumPresentUsageField(previous, envelope.tokenUsage, "totalTokens"),
  };
}

export function readAcpSelectedModel(
  runtime: BackendAcpSessionRuntimeState | undefined,
): string | undefined {
  return (
    readNonEmptyString(runtime?.currentModelId) ??
    readNonEmptyString(runtime?.configValues?.model)
  );
}

function sumPresentUsageField<K extends keyof AcpTokenUsage>(
  previous: AcpTokenUsage,
  next: AcpTokenUsage,
  key: K,
): Pick<AcpTokenUsage, K> | undefined {
  const previousValue = previous[key];
  const nextValue = next[key];
  if (previousValue === undefined && nextValue === undefined) {
    return undefined;
  }
  return {
    [key]: (previousValue ?? 0) + (nextValue ?? 0),
  } as Pick<AcpTokenUsage, K>;
}

function readAcpUpdateKind(update: Record<string, unknown>): string | undefined {
  const kind =
    update.sessionUpdate ?? update.session_update ?? update.kind ?? update.type;
  return typeof kind === "string" ? kind : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
