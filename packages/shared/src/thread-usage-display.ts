import type { ThreadUsageLineRecord } from "./token-usage-pricing";
import type { AppServerThreadEntry, AppServerThreadActivityEntry, AppServerThreadActivityDetail, AppServerThreadTurnMetadata } from "./contracts/normalized-app-server";
import { estimateTokenUsageCost, formatTokenUsagePriceFactor, formatTokenUsageMicrosAsUsd, formatTokenUsageStandardRateSuffix, formatTokenUsageUsd, formatTokenUsageUsdPerMillion, resolveOpenAiPricingServiceTier } from "./token-usage-pricing";

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readFiniteNumber(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = readNumber(record, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function findFirstNestedValue(
  value: unknown,
  keys: string[],
): unknown {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }

  for (const child of Object.values(record)) {
    const nested = findFirstNestedValue(child, keys);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
}

type TokenUsageBreakdown = {
  cacheWriteInputTokens?: number;
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

type TokenUsageScope = "latest-request" | "total";

type NormalizedTokenUsage = {
  scope: TokenUsageScope;
  tokens: TokenUsageBreakdown;
};

export function buildTokenUsageActivityEntry(params: {
  createdAt?: number;
  fastMode?: boolean;
  id: string;
  model?: string;
  pricingAt?: number;
  serviceTier?: string;
  summaryPrefix?: string;
  tokenUsage: unknown;
  turn?: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const normalized = normalizeTokenUsage(params.tokenUsage);
  if (!normalized) {
    return undefined;
  }

  const { scope, tokens } = normalized;
  const cachedInputTokens = Math.max(0, tokens.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cacheWriteInputTokens = Math.min(
    uncachedInputTokens,
    Math.max(0, tokens.cacheWriteInputTokens ?? 0),
  );
  const regularInputTokens = uncachedInputTokens - cacheWriteInputTokens;
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const cost = estimateTokenUsageCost({
    at: params.pricingAt,
    cacheWriteInputTokens,
    cachedInputTokens,
    fastMode: params.fastMode,
    inputTokenScope: scope === "latest-request" ? "request" : "aggregate",
    model: params.model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });
  const billedOutputTokens = cost?.outputTokensIncludeReasoning
    ? outputTokens
    : outputTokens + reasoningOutputTokens;
  const summaryParts = [
    `${formatTokenCount(uncachedInputTokens)} uncached in`,
    cacheWriteInputTokens > 0
      ? `${formatTokenCount(cacheWriteInputTokens)} cache writes`
      : undefined,
    `${formatTokenCount(cachedInputTokens)} cached`,
    reasoningOutputTokens > 0
      ? `${formatTokenCount(outputTokens)} out (${formatTokenCount(reasoningOutputTokens)} reasoning)`
      : `${formatTokenCount(outputTokens)} out`,
    cost ? `${formatTokenUsageUsd(cost.totalUsd)} list price` : undefined,
  ].filter((part): part is string => Boolean(part));
  const summaryPrefix =
    params.summaryPrefix ??
    (scope === "latest-request" ? "Latest request usage" : "Usage");

  const details: AppServerThreadActivityDetail[] = [
    {
      id: `${params.id}-input`,
      kind: "read",
      label: `Input: ${formatTokenCount(inputTokens)} tokens (${formatTokenCount(
        uncachedInputTokens,
      )} uncached, ${formatTokenCount(cachedInputTokens)} cached)`,
      status: "completed",
    },
    {
      id: `${params.id}-output`,
      kind: "read",
      label: `Output: ${formatTokenCount(outputTokens)} tokens${
        reasoningOutputTokens > 0
          ? `, including ${formatTokenCount(reasoningOutputTokens)} reasoning`
          : ""
      }`,
      status: "completed",
    },
  ];
  if (cost) {
    details.push(
      {
        id: `${params.id}-uncached-input-cost`,
        kind: "read",
        label: `Uncached input cost: ${formatTokenCount(
          regularInputTokens,
        )} tokens at ${formatTokenUsageUsdPerMillion(
          cost.inputUsdPerMillion,
        )}/M${formatTokenUsageStandardRateSuffix(
          cost.standardInputRateMultiplier,
        )} = ${formatTokenUsageUsd(cost.uncachedInputUsd)}`,
        status: "completed",
      },
      {
        id: `${params.id}-cached-input-cost`,
        kind: "read",
        label: `Cached input cost: ${formatTokenCount(
          cachedInputTokens,
        )} tokens at ${formatTokenUsageUsdPerMillion(
          cost.cachedInputUsdPerMillion,
        )}/M (${formatTokenUsagePriceFactor(
          cost.cachedInputUsdPerMillion,
          cost.inputUsdPerMillion,
        )} uncached${formatTokenUsageStandardRateSuffix(
          cost.standardCachedInputRateMultiplier,
          ", ",
        )}) = ${formatTokenUsageUsd(cost.cachedInputUsd)}`,
        status: "completed",
      },
      {
        id: `${params.id}-output-cost`,
        kind: "read",
        label: `Output cost: ${formatTokenCount(billedOutputTokens)} tokens at ${formatTokenUsageUsdPerMillion(
          cost.outputUsdPerMillion,
        )}/M${formatTokenUsageStandardRateSuffix(
          cost.standardOutputRateMultiplier,
        )} = ${formatTokenUsageUsd(cost.outputUsd)}`,
        status: "completed",
      },
    );
    if (
      cacheWriteInputTokens > 0
      && cost.cacheWriteInputUsdPerMillion !== undefined
    ) {
      details.push({
        id: `${params.id}-cache-write-input-cost`,
        kind: "read",
        label: `Cache write cost: ${formatTokenCount(
          cacheWriteInputTokens,
        )} tokens at ${formatTokenUsageUsdPerMillion(
          cost.cacheWriteInputUsdPerMillion,
        )}/M = ${formatTokenUsageUsd(cost.cacheWriteInputUsd)}`,
        status: "completed",
      });
    }
    details.push({
      id: `${params.id}-cost`,
      kind: "read",
      label: `Cost: ${formatTokenUsageUsd(cost.totalUsd)} list price for ${cost.displayName}`,
      status: "completed",
    });
  } else if (params.model) {
    details.push({
      id: `${params.id}-cost-unavailable`,
      kind: "read",
      label: `Cost unavailable: no local pricing entry for ${formatUnpricedModelName({
        fastMode: params.fastMode,
        model: params.model,
        serviceTier: params.serviceTier,
      })}`,
      status: "completed",
    });
  }

  return {
    type: "activity",
    id: params.id,
    createdAt: params.createdAt ?? Date.now(),
    summary: `${summaryPrefix}: ${summaryParts.join(" · ")}`,
    status: "completed",
    details,
    ...(params.turn ? { turn: params.turn } : {}),
  };
}

export function buildTurnUsageActivityEntryFromLine(params: {
  line: ThreadUsageLineRecord;
  turn: AppServerThreadTurnMetadata;
}): AppServerThreadActivityEntry | undefined {
  const { line, turn } = params;
  if (!line.turnId) {
    return undefined;
  }

  const id = `live-turn-usage-${line.turnId}`;
  const entry = buildTokenUsageActivityEntry({
    createdAt: line.completedAt ?? turn.completedAt ?? line.createdAt,
    fastMode: line.fastMode,
    id,
    model: line.model,
    pricingAt: line.createdAt,
    serviceTier: line.serviceTier,
    summaryPrefix: "Turn usage",
    tokenUsage: {
      total: {
        cacheWriteInputTokens: line.cacheWriteInputTokens,
        cachedInputTokens: line.cachedInputTokens,
        inputTokens: line.inputTokens,
        outputTokens: line.outputTokens,
        reasoningOutputTokens: line.reasoningOutputTokens,
        totalTokens: line.totalTokens,
      },
    },
    turn,
  });
  if (!entry) {
    return undefined;
  }

  const summaryParts = [
    `${formatTokenCount(line.uncachedInputTokens)} uncached in`,
    (line.cacheWriteInputTokens ?? 0) > 0
      ? `${formatTokenCount(line.cacheWriteInputTokens ?? 0)} cache writes`
      : undefined,
    `${formatTokenCount(line.cachedInputTokens)} cached`,
    line.reasoningOutputTokens > 0
      ? `${formatTokenCount(line.outputTokens)} out (${formatTokenCount(
          line.reasoningOutputTokens,
        )} reasoning)`
      : `${formatTokenCount(line.outputTokens)} out`,
    line.priceStatus === "priced"
      ? `${formatTokenUsageMicrosAsUsd(line.totalCostMicros)} list price`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  const exactCostsByDetailId = new Map([
    [`${id}-uncached-input-cost`, line.uncachedInputCostMicros],
    [`${id}-cache-write-input-cost`, line.cacheWriteInputCostMicros ?? 0],
    [`${id}-cached-input-cost`, line.cachedInputCostMicros],
    [`${id}-output-cost`, line.outputCostMicros],
  ]);
  const details = entry.details
    .filter(
      (detail) =>
        line.priceStatus !== "priced"
        || detail.id !== `${id}-cost-unavailable`,
    )
    .map((detail) => {
      const exactCostMicros = exactCostsByDetailId.get(detail.id);
      if (exactCostMicros !== undefined && detail.label.includes(" = ")) {
        return {
          ...detail,
          label: detail.label.replace(
            / = [^=]+$/,
            ` = ${formatTokenUsageMicrosAsUsd(exactCostMicros)}`,
          ),
        };
      }
      if (detail.id === `${id}-cost`) {
        return {
          ...detail,
          label: detail.label.replace(
            /^Cost: .*? list price/,
            `Cost: ${formatTokenUsageMicrosAsUsd(line.totalCostMicros)} list price`,
          ),
        };
      }
      return detail;
    });
  if (
    line.priceStatus === "priced"
    && !details.some((detail) => detail.id === `${id}-cost`)
  ) {
    details.push({
      id: `${id}-cost`,
      kind: "read",
      label: `Cost: ${formatTokenUsageMicrosAsUsd(line.totalCostMicros)} list price`,
      status: "completed",
    });
  }

  return {
    ...entry,
    details,
    summary: `Turn usage: ${summaryParts.join(" · ")}`,
    usageLine: line,

  };
}

function normalizeTokenUsage(tokenUsage: unknown): NormalizedTokenUsage | undefined {
  const root =
    readRecord(findFirstNestedValue(tokenUsage, ["tokenUsage", "token_usage", "info"])) ??
    readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const latestUsageRecord =
    readRecord(findFirstNestedValue(root, ["last", "last_token_usage"])) ??
    readRecord(root.last) ??
    readRecord(root.last_token_usage);
  const totalUsageRecord =
    readRecord(findFirstNestedValue(root, ["total", "total_token_usage"])) ??
    readRecord(root.total) ??
    readRecord(root.total_token_usage);
  const currentUsageRecord = latestUsageRecord ?? totalUsageRecord ?? root;
  const tokens = readTokenBreakdown(currentUsageRecord);
  if (!tokens) {
    return undefined;
  }

  return {
    scope: latestUsageRecord ? "latest-request" : "total",
    tokens,
  };
}

function readTokenBreakdown(record: Record<string, unknown>): TokenUsageBreakdown | undefined {
  const explicitTotal = readFiniteNumber(record, ["totalTokens", "total_tokens"]);
  const inputTokens = readFiniteNumber(record, ["inputTokens", "input_tokens"]);
  const cacheWriteInputTokens = readFiniteNumber(record, [
    "cacheWriteInputTokens",
    "cache_write_input_tokens",
    "cache_write_tokens",
  ]);
  const cachedInputTokens = readFiniteNumber(record, [
    "cachedInputTokens",
    "cached_input_tokens",
  ]);
  const outputTokens = readFiniteNumber(record, ["outputTokens", "output_tokens"]);
  const reasoningOutputTokens = readFiniteNumber(record, [
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  ]);
  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
  const totalTokens = explicitTotal ?? (derivedTotal > 0 ? derivedTotal : undefined);

  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cacheWriteInputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }

  return {
    cacheWriteInputTokens,
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function formatUnpricedModelName(params: {
  fastMode?: boolean;
  model: string;
  serviceTier?: string;
}): string {
  const serviceTier = resolveOpenAiPricingServiceTier(params);
  return [
    params.model,
    serviceTier === "priority" ? "Fast/Priority" : undefined,
    serviceTier === undefined && params.serviceTier
      ? `service tier ${params.serviceTier}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
}

export function tokenUsageActivityScope(
  entry: AppServerThreadActivityEntry
): "latest-request" | "total" | "turn" | undefined {
  if (entry.id.startsWith("live-turn-usage-") || entry.summary.startsWith("Turn usage:")) {
    return "turn";
  }
  if (entry.summary.startsWith("Latest request usage:")) {
    return "latest-request";
  }
  if (entry.summary.startsWith("Usage:")) {
    return "total";
  }
  if (entry.id.startsWith("live-token-usage-")) {
    return "latest-request";
  }
  return undefined;
}

export function isTerminalTurnMetadata(
  turn: AppServerThreadTurnMetadata | undefined,
): boolean {
  return Boolean(
    turn
    && (
      turn.status === "completed"
      || turn.status === "failed"
      || turn.status === "cancelled"
      || turn.status === "interrupted"
      || typeof turn.completedAt === "number"
    )
  );
}

export function preferTurnUsageLine(
  current: ThreadUsageLineRecord | undefined,
  candidate: ThreadUsageLineRecord,
): ThreadUsageLineRecord {
  if (!current) {
    return candidate;
  }
  if (candidate.source === "live" && current.source !== "live") {
    return candidate;
  }
  if (candidate.turnUsageAttributed === true && current.turnUsageAttributed !== true) {
    return candidate;
  }
  const currentAt = current.completedAt ?? current.createdAt;
  const candidateAt = candidate.completedAt ?? candidate.createdAt;
  return candidateAt >= currentAt ? candidate : current;
}

export function reconcileCompletedTurnUsageEntries(params: {
  activeTurnId?: string;
  entries: AppServerThreadEntry[];
  lines?: ThreadUsageLineRecord[];
  requireExistingTurnUsage?: boolean;
}): AppServerThreadEntry[] {
  const contentTurnById = new Map<string, AppServerThreadTurnMetadata>();
  const existingTurnUsageByTurnId = new Map<
    string,
    AppServerThreadActivityEntry
  >();

  for (const entry of params.entries) {
    const turnId =
      entry.turn?.id
      ?? (entry.type === "activity" ? entry.usageLine?.turnId : undefined);
    if (!turnId || turnId === params.activeTurnId) {
      continue;
    }
    if (
      entry.type === "activity"
      && tokenUsageActivityScope(entry) === "turn"
    ) {
      existingTurnUsageByTurnId.set(turnId, entry);
      continue;
    }
    if (
      entry.type === "activity"
      && tokenUsageActivityScope(entry) !== undefined
    ) {
      continue;
    }
    if (entry.turn) {
      contentTurnById.set(turnId, entry.turn);
    }
  }

  const authoritativeLineByTurnId = new Map<string, ThreadUsageLineRecord>();
  for (const line of params.lines ?? []) {
    if (
      !line.turnId
      || line.turnId === params.activeTurnId
      || line.scope !== "turn"
      || line.status === "superseded"
      || line.turnUsageAttributed === false
      || !contentTurnById.has(line.turnId)
    ) {
      continue;
    }
    authoritativeLineByTurnId.set(
      line.turnId,
      preferTurnUsageLine(authoritativeLineByTurnId.get(line.turnId), line),
    );
  }

  const replacementByTurnId = new Map<string, AppServerThreadActivityEntry>();
  for (const [turnId, contentTurn] of contentTurnById) {
    const existingUsage = existingTurnUsageByTurnId.get(turnId);
    if (params.requireExistingTurnUsage && !existingUsage) {
      continue;
    }
    const line = authoritativeLineByTurnId.get(turnId);
    const completedAt =
      line?.completedAt
      ?? contentTurn.completedAt
      ?? existingUsage?.turn?.completedAt;
    const terminal = typeof completedAt === "number"
      || isTerminalTurnMetadata(contentTurn)
      || isTerminalTurnMetadata(existingUsage?.turn);
    if (!terminal) {
      continue;
    }

    const startedAt =
      contentTurn.startedAt
      ?? line?.startedAt
      ?? existingUsage?.turn?.startedAt;
    const interruptedStatus =
      contentTurn.status === "failed"
      || contentTurn.status === "cancelled"
      || contentTurn.status === "interrupted"
        ? contentTurn.status
        : existingUsage?.turn?.status === "failed"
          || existingUsage?.turn?.status === "cancelled"
          || existingUsage?.turn?.status === "interrupted"
          ? existingUsage.turn.status
          : undefined;
    const turn: AppServerThreadTurnMetadata = {
      ...contentTurn,
      id: turnId,
      status: interruptedStatus ?? "completed",
      ...(typeof startedAt === "number" ? { startedAt } : {}),
      ...(typeof completedAt === "number" ? { completedAt } : {}),
      ...(typeof (contentTurn.durationMs ?? existingUsage?.turn?.durationMs) === "number"
        ? {
            durationMs:
              contentTurn.durationMs ?? existingUsage?.turn?.durationMs,
          }
        : typeof startedAt === "number" && typeof completedAt === "number"
          ? { durationMs: Math.max(0, completedAt - startedAt) }
          : {}),
    };
    const authoritativeEntry = line
      ? buildTurnUsageActivityEntryFromLine({ line, turn })
      : undefined;
    if (authoritativeEntry) {
      replacementByTurnId.set(turnId, authoritativeEntry);
      continue;
    }
    if (existingUsage) {
      replacementByTurnId.set(
        turnId,
        typeof completedAt === "number"
          ? { ...existingUsage, createdAt: completedAt, turn }
          : { ...existingUsage, turn },
      );
    }
  }

  if (replacementByTurnId.size === 0) {
    return params.entries;
  }

  const filteredEntries: AppServerThreadEntry[] = [];
  const lastEntryIndexByTurnId = new Map<string, number>();
  for (const entry of params.entries) {
    const usageTurnId = entry.type === "activity"
      ? entry.turn?.id ?? entry.usageLine?.turnId
      : undefined;
    const scope = entry.type === "activity"
      ? tokenUsageActivityScope(entry)
      : undefined;
    if (
      usageTurnId
      && replacementByTurnId.has(usageTurnId)
      && (scope === "latest-request" || scope === "total" || scope === "turn")
    ) {
      continue;
    }

    const index = filteredEntries.length;
    filteredEntries.push(entry);
    if (entry.turn?.id && replacementByTurnId.has(entry.turn.id)) {
      lastEntryIndexByTurnId.set(entry.turn.id, index);
    }
  }

  const replacementAfterIndex = new Map<number, AppServerThreadActivityEntry>();
  for (const [turnId, replacement] of replacementByTurnId) {
    const anchorIndex = lastEntryIndexByTurnId.get(turnId);
    if (anchorIndex !== undefined) {
      replacementAfterIndex.set(anchorIndex, replacement);
    }
  }

  return filteredEntries.flatMap((entry, index) => {
    const replacement = replacementAfterIndex.get(index);
    return replacement ? [entry, replacement] : [entry];
  });
}
