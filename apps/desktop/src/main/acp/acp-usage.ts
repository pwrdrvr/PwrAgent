import type { BackendAcpSessionRuntimeState } from "@pwragent/shared/contracts/backend";

export type AcpTokenUsage = {
  cacheWriteInputTokens?: number;
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

/**
 * ACP running totals are PER TURN, not per session. That is the convention for
 * this transport, deliberately, not an accident of one provider.
 *
 * `AcpBackendAdapter` folds these envelopes into a `liveTurnUsage` entry keyed
 * by `(backend, session, turn)` and drops it at `turn_finished`, so the sum
 * restarts at zero on every turn. That is the number it sends as
 * `total_token_usage` on `thread/tokenUsage/updated`.
 *
 * Every ACP agent known to report usage reports it per turn or per model call,
 * which folds to per turn: Grok on `response_completed` and `turn_completed`,
 * Qwen on `agent_message_chunk._meta.usage`, and Antigravity 1.5.14 on the
 * `session/prompt` result (`result.usage`). Antigravity's `result.usage` is a
 * per-turn total across all model calls in the turn with exclusive
 * `inputTokens` (uncached input), `cachedReadTokens`, `cachedWriteTokens`,
 * `outputTokens` (already including `thoughtTokens`), and `totalTokens` equal
 * to `inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens`, with
 * no cost field; `AcpAgentClient` attaches it to its synthetic `turn_finished`
 * update so this layer normalizes it into PwrAgent's inclusive `inputTokens`
 * convention. Kimi Code 0.31.1 reports none at all —
 * `kimi-code-0-31-cereal.json` is a full captured turn with no usage anywhere,
 * so a Kimi thread cannot be priced. Kimi Code 2.0.0 still cannot: a captured
 * turn returns only `stopReason` from `session/prompt`, and its new
 * `usage_update` carries context fill (`used` of `size`) with no cost.
 * Gemini is still untested; the `acp-transcripts` parity captures cannot
 * answer it, since they hold no
 * completed turn (grok-build.json carries no usage either, and Grok certainly
 * reports). Codex is the outlier among the reporters: it sends this field
 * meaning a session-cumulative total, which is why
 * `deriveLiveThreadTokenUsage` can read `total - last` as "the context this
 * turn inherited". For ACP that subtraction lands on zero on a turn's first
 * call, which is equally correct: the turn did start from nothing.
 *
 * If a future agent reports cumulative instead, do NOT quietly widen this
 * function to accept both. The shapes are indistinguishable from a single
 * observation, so the reader would have to guess. Track which providers (and
 * which versions) report which way, and normalize on that, keeping per-turn as
 * the shape this layer hands downstream.
 *
 * Two consequences of per-turn that the field name hides:
 *
 *  - `deriveTurnUsageBaseline` (renderer) prefers `contextWindow.cumulative*`
 *    over `total - last` when a context window is known. These token usage
 *    notifications carry no `modelContextWindow`, and must not start to:
 *    adding one would feed a per-turn total into a baseline that expects a
 *    session-cumulative one, and the live turn usage would collapse toward
 *    zero. ACP context fill (`usage_update`) travels separately as
 *    `thread/contextWindow/updated`, which sets no `cumulative*` field, so it
 *    lights the indicator without reaching that baseline. Fix the baseline
 *    preference before routing any context window through this payload.
 *  - `foldObservedContextReplay` keeps its cursor per THREAD and treats a
 *    total at or below the cursor as a stale re-emission. Per-turn totals
 *    restart below it, so after the first turn an ACP thread stops advancing
 *    that cursor. Nothing regressed — the fold needs a total and ACP sent none
 *    before — but the practical position is that ACP does not participate in
 *    replay accounting, and a half-advanced cursor is easy to mistake for one
 *    that works.
 */

export function readAcpPromptResultUsage(
  result: unknown,
  backendId?: string,
): Record<string, unknown> | undefined {
  if (backendId !== "acp:antigravity") {
    return undefined;
  }
  const usage = readRecord(readRecord(result)?.usage);
  return readAntigravityPromptUsageEnvelope(usage) ? usage : undefined;
}

export function readAcpPromptResultUsageEnvelope(
  result: unknown,
  backendId?: string,
): AcpUsageEnvelope | undefined {
  if (backendId !== "acp:antigravity") {
    return undefined;
  }
  return readAntigravityPromptUsageEnvelope(readRecord(readRecord(result)?.usage));
}

export function readAcpUsageEnvelope(
  update: Record<string, unknown>,
  backendId?: string,
): AcpUsageEnvelope | undefined {
  const kind = readAcpUpdateKind(update);
  if (kind === "response_completed") {
    return readGrokResponseUsageEnvelope(readRecord(update.usage));
  }
  if (kind === "turn_finished") {
    return backendId === "acp:antigravity"
      ? readAntigravityPromptUsageEnvelope(readRecord(update.usage))
      : undefined;
  }
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

/**
 * Grok Build's per-model-call usage, carried on the transient
 * `response_completed` extension update. Its `ResponseUsage` struct is
 * snake_case on the wire and reports the *uncached* prompt remainder:
 *
 *   input_tokens = prompt − cache_read_input_tokens − cache_creation_input_tokens
 *
 * `turn_completed.usage` is camelCase and its `inputTokens` is the whole
 * prompt. Normalizing to the inclusive convention here is what lets a running
 * sum of model calls land on the same numbers the turn total reports, instead
 * of trailing it by the cached portion and jumping at the end of the turn.
 */
function readGrokResponseUsageEnvelope(
  usage: Record<string, unknown> | undefined,
): AcpUsageEnvelope | undefined {
  if (!usage) {
    return undefined;
  }
  const uncachedInputTokens = readFiniteNumber(usage.input_tokens);
  const cachedInputTokens = readFiniteNumber(usage.cache_read_input_tokens);
  const cacheCreationTokens = readFiniteNumber(
    usage.cache_creation_input_tokens,
  );
  const outputTokens = readFiniteNumber(usage.output_tokens);
  const reasoningOutputTokens = readFiniteNumber(usage.reasoning_tokens);
  if (
    uncachedInputTokens === undefined
    && cachedInputTokens === undefined
    && cacheCreationTokens === undefined
    && outputTokens === undefined
    && reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  // Cache-creation tokens land in `inputTokens` but not in
  // `cachedInputTokens`, so downstream `inputTokens - cachedInputTokens`
  // prices them as uncached input. That mirrors `turn_completed.usage`, whose
  // `cacheCreationTokens` is a separate field this parser also folds nowhere
  // — matching it is what keeps the running sum and the turn total in
  // agreement. It is not a claim about how xAI bills cache writes.
  const inputTokens =
    uncachedInputTokens !== undefined
    || cachedInputTokens !== undefined
    || cacheCreationTokens !== undefined
      ? (uncachedInputTokens ?? 0)
        + (cachedInputTokens ?? 0)
        + (cacheCreationTokens ?? 0)
      : undefined;
  // Grok's turn total reports totalTokens as prompt + completion, so derive
  // the same sum per call rather than leaving it for a later consumer to
  // guess at from a partially-populated envelope.
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined;
  return {
    scope: "model-call",
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

/**
 * Antigravity 1.5.14 reports per-turn token usage on the `session/prompt`
 * JSON-RPC result (`result.usage`) with exclusive uncached `inputTokens`:
 *
 *   totalTokens = inputTokens + cachedReadTokens + cachedWriteTokens + outputTokens
 *
 * `outputTokens` already includes `thoughtTokens`. Normalize `inputTokens` to
 * PwrAgent's inclusive total-input convention so downstream
 * `inputTokens - cachedInputTokens` recovers `uncached + cacheWrite` without
 * undercounting cached prompts.
 */
function readAntigravityPromptUsageEnvelope(
  usage: Record<string, unknown> | undefined,
): AcpUsageEnvelope | undefined {
  if (!usage) {
    return undefined;
  }
  const uncachedInputTokens = readFiniteNumber(usage.inputTokens);
  const cachedInputTokens =
    readFiniteNumber(usage.cachedReadTokens)
    ?? readFiniteNumber(usage.cachedInputTokens);
  const cacheWriteInputTokens =
    readFiniteNumber(usage.cachedWriteTokens)
    ?? readFiniteNumber(usage.cacheWriteInputTokens)
    ?? readFiniteNumber(usage.cacheCreationTokens);
  const outputTokens = readFiniteNumber(usage.outputTokens);
  const reasoningOutputTokens =
    readFiniteNumber(usage.thoughtTokens)
    ?? readFiniteNumber(usage.reasoningTokens)
    ?? readFiniteNumber(usage.reasoningOutputTokens);
  const explicitTotalTokens = readFiniteNumber(usage.totalTokens);
  if (
    uncachedInputTokens === undefined
    && cachedInputTokens === undefined
    && cacheWriteInputTokens === undefined
    && outputTokens === undefined
    && reasoningOutputTokens === undefined
    && explicitTotalTokens === undefined
  ) {
    return undefined;
  }

  const inputTokens =
    uncachedInputTokens !== undefined
    || cachedInputTokens !== undefined
    || cacheWriteInputTokens !== undefined
      ? (uncachedInputTokens ?? 0)
        + (cachedInputTokens ?? 0)
        + (cacheWriteInputTokens ?? 0)
      : undefined;
  const totalTokens =
    explicitTotalTokens
    ?? (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const modelUsage = readRecord(usage.modelUsage);
  const model =
    readNonEmptyString(usage.model)
    ?? readNonEmptyString(usage.modelId)
    ?? readNonEmptyString(usage.model_id)
    ?? (modelUsage ? Object.keys(modelUsage)[0] : undefined);
  return {
    ...(model ? { model } : {}),
    scope: "turn",
    tokenUsage: {
      ...(cacheWriteInputTokens !== undefined && cacheWriteInputTokens > 0
        ? { cacheWriteInputTokens }
        : {}),
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
    ...sumPresentUsageField(previous, envelope.tokenUsage, "cacheWriteInputTokens"),
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
