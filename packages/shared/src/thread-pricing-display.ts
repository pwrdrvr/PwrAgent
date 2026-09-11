import type { ThreadPricingSummary, ThreadUsageLineRecord } from "./token-usage-pricing";
import type { ThreadSubAgentSummary, ThreadTurnFailure } from "./contracts/navigation";
import type { ThreadCompactionRecord, ThreadTokenMiserAccounting, ThreadTokenMiserInterceptionAccounting } from "./contracts/normalized-app-server";
import { estimateOpenAiCodexCreditUsage } from "./token-usage-pricing";
import { estimateHistoricalThreadUsageGapLines } from "./thread-pricing-projection";
import { addUsageLineToSummary, buildPricingSpendByModel, emptyPricingSummary } from "./pricing-spend-by-model";
import { buildTokenMiserSavingsSummary } from "./token-miser-savings-summary";

function isTerminalSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return ["success", "failure", "cancelled"].includes(subAgent.status) || subAgent.completedAt !== undefined || subAgent.outcome !== undefined || subAgent.completionSource !== undefined;
}

export type PricingUsageLine = ThreadUsageLineRecord & {
  estimatedUsageGap?: true;
};

/** Pricing never needs a helper's task, output, runtime ownership, or usage ledger. */
export type PricingSubAgent = Pick<ThreadSubAgentSummary,
  "monitorId" | "backend" | "agentName" | "preferredModel" | "preferredReasoningEffort"
  | "createdAt" | "updatedAt" | "status" | "completedAt" | "monitorTurnId" | "tokenMiserAccounting"
>;

export type PricingDecision = Pick<ThreadTokenMiserInterceptionAccounting, "decisionSource" | "disposition">;
export type PricingGateSelection = { usageLineId: string; filter: "primary" | "small" };
/**
 * A gate below this saved (or cost) too little to earn its own card. Its
 * dollars still count in the turn's summary line; only the card is withheld.
 * Ten cents is where a card stops being noise: below it the equation reads as
 * rounding, above it the reader can see which term moved.
 */
export const TOKEN_MISER_CARD_MIN_MICROS = 100_000;

function pricingSubAgent(agent: ThreadSubAgentSummary | undefined): PricingSubAgent | undefined {
  if (!agent) return undefined;
  return {
    monitorId: agent.monitorId, backend: agent.backend, agentName: agent.agentName,
    preferredModel: agent.preferredModel ?? agent.monitorUsage?.model ?? agent.monitorUsage?.cost?.model,
    preferredReasoningEffort: agent.preferredReasoningEffort,
    createdAt: agent.createdAt, updatedAt: agent.updatedAt, status: agent.status,
    completedAt: agent.completedAt ?? (isTerminalSubAgent(agent) && agent.updatedAt >= agent.createdAt ? agent.updatedAt : undefined),
    monitorTurnId: agent.monitorTurnId, tokenMiserAccounting: agent.tokenMiserAccounting,
  };
}

export function partitionPricingGateCards(
  gates: readonly PricingUsageLine[],
  subAgentsById: ReadonlyMap<string, Pick<ThreadSubAgentSummary, "tokenMiserAccounting">>,
) {
  const accounting = (line: PricingUsageLine) => line.sourceItemId ? subAgentsById.get(line.sourceItemId)?.tokenMiserAccounting : undefined;
  const priced = gates.filter((line) => accounting(line) !== undefined);
  const significant = priced.filter((line) => Math.abs(accounting(line)!.savingsMicros) >= TOKEN_MISER_CARD_MIN_MICROS);
  const primary = significant.length ? significant : priced;
  const primaryIds = new Set(primary.map((line) => line.usageLineId));
  return { primary, small: priced.filter((line) => !primaryIds.has(line.usageLineId)), unpricedCount: gates.length - priced.length };
}

/** All folded-group figures are computed on the owner, independent of loaded gate pages. */
export function buildPricingGateGroupDisplay(params: {
  gates: readonly PricingUsageLine[];
  subAgentsById: ReadonlyMap<string, Pick<ThreadSubAgentSummary, "tokenMiserAccounting">>;
  decisions?: readonly PricingDecision[];
}) {
  const { gates, subAgentsById, decisions } = params;
  const { primary, small, unpricedCount } = partitionPricingGateCards(gates, subAgentsById);
  const accountings = gates.map((line) => line.sourceItemId ? subAgentsById.get(line.sourceItemId)?.tokenMiserAccounting : undefined);
  const decisionRows = decisions ?? accountings;
  return {
    gateCount: gates.length, primaryCount: primary.length, smallCount: small.length, unpricedCount,
    smallMicros: small.reduce((sum, line) => sum + subAgentsById.get(line.sourceItemId!)!.tokenMiserAccounting!.savingsMicros, 0),
    savingsMicros: accountings.reduce((sum, accounting) => sum + (accounting?.savingsMicros ?? 0), 0),
    gateCostMicros: gates.reduce((sum, line) => sum + line.totalCostMicros, 0),
    hasDecisions: decisions !== undefined,
    count: decisions?.length ?? gates.length,
    helperDecisionCount: decisionRows.filter((decision) => decision?.decisionSource !== "policy").length,
    policyDecisionCount: decisionRows.filter((decision) => decision?.decisionSource === "policy").length,
    helperPassThroughCount: decisionRows.filter((decision) => decision?.disposition === "passed_through" && decision.decisionSource !== "policy").length,
    policyPassThroughCount: decisionRows.filter((decision) => decision?.disposition === "passed_through" && decision.decisionSource === "policy").length,
  };
}

export type PricingGateGroupDisplay = ReturnType<typeof buildPricingGateGroupDisplay>;

export type PricingUsageRowData = {
  line: PricingUsageLine;
  nested: boolean;
  orphan: boolean;
  isActive: boolean;
  lineTotals: PricingRunningLineTotals | undefined;
  rowCompactions: ThreadCompactionRecord[];
  subAgent: PricingSubAgent | undefined;
  turnFailure: ThreadTurnFailure | undefined;
  threadReasoningEffort: string | undefined;
  decisions: PricingDecision[] | undefined;
  gateSummary?: PricingGateGroupDisplay;
  gatesDeferred?: true;
  gates: PricingUsageRowData[];
};

export function resolveUsageLineModel(
  line: ThreadUsageLineRecord,
  subAgent?: Pick<ThreadSubAgentSummary, "preferredModel" | "monitorUsage">,
): string | undefined {
  return (
    line.model
    ?? subAgent?.preferredModel
    ?? subAgent?.monitorUsage?.model
    ?? subAgent?.monitorUsage?.cost?.model
  );
}

export const TOKEN_MISER_SOURCE_PREFIX = "system:token-miser:";

export function isTokenMiserGateLine(line: PricingUsageLine): boolean {
  return line.scope === "monitor"
    && Boolean(line.sourceItemId?.startsWith(TOKEN_MISER_SOURCE_PREFIX));
}

export function partitionTokenMiserGateLines(
  lines: readonly PricingUsageLine[],
  subAgentsById: Map<string, ThreadSubAgentSummary>,
): {
  displayLines: PricingUsageLine[];
  gateLinesByTurn: Map<string, PricingUsageLine[]>;
  /**
   * Gates with no turn row to nest under — a native review's inner turn, or a
   * turn whose usage has not landed yet — grouped by parent turn and keyed by
   * the usage line they should render in place of, so the group keeps the
   * position of its newest gate rather than surfacing as N loose cards.
   */
  orphanGroupsByAnchor: Map<string, PricingUsageLine[]>;
} {
  const turnRowIds = new Set<string>();
  for (const line of lines) {
    if (!isTokenMiserGateLine(line) && line.scope !== "monitor" && line.turnId) {
      turnRowIds.add(line.turnId);
    }
  }
  const gateLinesByTurn = new Map<string, PricingUsageLine[]>();
  const orphansByTurn = new Map<string, PricingUsageLine[]>();
  const displayLines: PricingUsageLine[] = [];
  const push = (map: Map<string, PricingUsageLine[]>, key: string, line: PricingUsageLine) => {
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(line);
    } else {
      map.set(key, [line]);
    }
  };
  for (const line of lines) {
    if (!isTokenMiserGateLine(line)) {
      displayLines.push(line);
      continue;
    }
    const parentTurnId = line.sourceItemId
      ? subAgentsById.get(line.sourceItemId)?.parentTurnId
      : undefined;
    if (parentTurnId && turnRowIds.has(parentTurnId)) {
      push(gateLinesByTurn, parentTurnId, line);
      continue;
    }
    // No parent turn known at all (a gate persisted before parentTurnId
    // existed) groups under its own id, so it still gets the compact form.
    push(orphansByTurn, parentTurnId ?? `gate:${line.usageLineId}`, line);
  }
  // Lines are newest-first; the first gate seen in each orphan group is its
  // anchor. It stays in the flat list as a placeholder the renderer swaps for
  // the group.
  const orphanGroupsByAnchor = new Map<string, PricingUsageLine[]>();
  for (const gates of orphansByTurn.values()) {
    const anchor = gates[0]!;
    orphanGroupsByAnchor.set(anchor.usageLineId, gates);
    displayLines.push(anchor);
  }
  displayLines.sort(compareUsageLinesDescending);
  return { displayLines, gateLinesByTurn, orphanGroupsByAnchor };
}

export function tokenMiserDecisionsForTurn(
  accounting: ThreadTokenMiserAccounting | undefined,
  turnId: string | undefined,
): ThreadTokenMiserInterceptionAccounting[] | undefined {
  if (!accounting?.interceptions || !turnId) {
    return undefined;
  }
  const decisions = accounting.interceptions.filter((decision) =>
    decision.turnId === turnId
  );
  return decisions.length > 0 ? decisions : undefined;
}

export function tokenMiserDecisionsForGateLines(params: {
  accounting?: ThreadTokenMiserAccounting;
  gates: readonly PricingUsageLine[];
  subAgentsById: Map<string, ThreadSubAgentSummary>;
}): ThreadTokenMiserInterceptionAccounting[] | undefined {
  if (!params.accounting?.interceptions) {
    return undefined;
  }
  const turnIds = new Set(
    params.gates.flatMap((gate) => {
      const turnId = gate.sourceItemId
        ? params.subAgentsById.get(gate.sourceItemId)?.parentTurnId
        : undefined;
      return turnId ? [turnId] : [];
    }),
  );
  const decisions = params.accounting.interceptions.filter((decision) =>
    turnIds.has(decision.turnId)
  );
  return decisions.length > 0 ? decisions : undefined;
}

export const COMPACTION_TURN_KEY_PREFIX = "turn:";

export function groupCompactionsByRow(
  compactions: readonly ThreadCompactionRecord[],
): Map<string, ThreadCompactionRecord[]> {
  const grouped = new Map<string, ThreadCompactionRecord[]>();
  for (const compaction of compactions) {
    const key = compaction.coldUsageLineId
      ?? (compaction.turnId
        ? `${COMPACTION_TURN_KEY_PREFIX}${compaction.turnId}`
        : undefined);
    if (!key) {
      continue;
    }
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(compaction);
    } else {
      grouped.set(key, [compaction]);
    }
  }
  return grouped;
}

export function selectRowCompactions(
  grouped: Map<string, ThreadCompactionRecord[]>,
  line: PricingUsageLine,
  claimedTurnKeys: Set<string>,
): ThreadCompactionRecord[] {
  if (grouped.size === 0 || line.scope === "monitor") {
    return [];
  }
  const attributed = grouped.get(line.usageLineId) ?? [];
  // Unattributed markers are claimed by one row per turn, not every row in it.
  // A turn routinely has several usage lines, and showing the pending marker on
  // each of them read as several compactions rather than one.
  const turnKey = line.turnId
    ? `${COMPACTION_TURN_KEY_PREFIX}${line.turnId}`
    : undefined;
  const pending = turnKey && !claimedTurnKeys.has(turnKey)
    ? (grouped.get(turnKey) ?? [])
    : [];
  if (turnKey && pending.length > 0) {
    claimedTurnKeys.add(turnKey);
  }
  return [...attributed, ...pending];
}

export function buildPricingDisplayLines(lines: ThreadUsageLineRecord[]): PricingUsageLine[] {
  return [
    ...lines,
    ...estimateHistoricalThreadUsageGapLines(lines),
  ].sort(compareUsageLinesDescending);
}

export function addEstimatedLinesToSummaries(
  summaries: ThreadPricingSummary[],
  estimatedLines: PricingUsageLine[],
): ThreadPricingSummary[] {
  if (summaries.length === 0 || estimatedLines.length === 0) {
    return summaries;
  }

  const byKey = new Map<string, ThreadPricingSummary>();
  for (const summary of summaries) {
    byKey.set(summaryKey(summary), { ...summary });
  }
  for (const line of estimatedLines) {
    const key = usageLineSummaryKey(line);
    const existing = byKey.get(key) ?? emptyPricingSummary(line);
    byKey.set(key, addUsageLineToSummary(existing, line));
  }
  return [...byKey.values()].sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    return providerCompare !== 0
      ? providerCompare
      : left.currency.localeCompare(right.currency);
  });
}

export function aggregateUsageLines(lines: PricingUsageLine[]): ThreadPricingSummary | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  return lines.reduce<ThreadPricingSummary>(
    (summary, line) => addUsageLineToSummary(summary, line),
    emptyPricingSummary(lines[0]),
  );
}

export function summaryKey(summary: ThreadPricingSummary): string {
  return [
    summary.backend,
    summary.threadId,
    summary.provider,
    summary.currency,
  ].join(":");
}

export function usageLineSummaryKey(line: PricingUsageLine): string {
  return [
    line.backend,
    line.parentThreadId ?? line.threadId,
    line.provider,
    line.currency,
  ].join(":");
}

export function compareUsageLinesAscending(
  left: ThreadUsageLineRecord,
  right: ThreadUsageLineRecord,
): number {
  const leftTimestamp = lineSortTimestamp(left);
  const rightTimestamp = lineSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return leftTimestamp - rightTimestamp;
  }
  return left.usageLineId.localeCompare(right.usageLineId);
}

export function compareUsageLinesDescending(
  left: ThreadUsageLineRecord,
  right: ThreadUsageLineRecord,
): number {
  const leftTimestamp = lineSortTimestamp(left);
  const rightTimestamp = lineSortTimestamp(right);
  if (leftTimestamp !== rightTimestamp) {
    return rightTimestamp - leftTimestamp;
  }
  return right.usageLineId.localeCompare(left.usageLineId);
}

export function lineSortTimestamp(line: ThreadUsageLineRecord): number {
  return line.startedAt ?? line.createdAt;
}

export function isEstimatedUsageGap(line: ThreadUsageLineRecord): boolean {
  return "estimatedUsageGap" in line && line.estimatedUsageGap === true;
}

export function isForkBaselineLine(line: ThreadUsageLineRecord): boolean {
  return line.scope === "fork-baseline";
}

export function isActiveLiveTurnUsageLine(params: {
  activeTurnId?: string;
  line: PricingUsageLine;
}): boolean {
  return (
    params.line.scope === "turn" &&
    params.line.source === "live" &&
    Boolean(params.activeTurnId) &&
    params.line.turnId === params.activeTurnId
  );
}

export function isActiveUsageLine(params: {
  activeTurnId?: string;
  line: PricingUsageLine;
  subAgentsById: Map<string, ThreadSubAgentSummary>;
}): boolean {
  if (
    isActiveLiveTurnUsageLine({
      activeTurnId: params.activeTurnId,
      line: params.line,
    })
  ) {
    return true;
  }
  if (params.line.scope !== "monitor" || !params.line.sourceItemId) {
    return false;
  }
  const subAgent = params.subAgentsById.get(params.line.sourceItemId);
  return Boolean(subAgent && !isTerminalSubAgent(subAgent));
}

export function aggregateSummaries(
  summaries: ThreadPricingSummary[],
): ThreadPricingSummary | undefined {
  if (summaries.length === 0) {
    return undefined;
  }
  const [first, ...rest] = summaries;
  if (!first) {
    return undefined;
  }
  if (rest.some((summary) => summary.currency !== first.currency)) {
    return first;
  }
  return rest.reduce<ThreadPricingSummary>(
    (acc, summary) => ({
      ...acc,
      cachedInputTokens: acc.cachedInputTokens + summary.cachedInputTokens,
      inputTokens: acc.inputTokens + summary.inputTokens,
      outputTokens: acc.outputTokens + summary.outputTokens,
      pricedUsageLineCount:
        acc.pricedUsageLineCount + summary.pricedUsageLineCount,
      provider: summaries.length === 1 ? acc.provider : "multiple",
      reasoningOutputTokens:
        acc.reasoningOutputTokens + summary.reasoningOutputTokens,
      totalCostMicros: acc.totalCostMicros + summary.totalCostMicros,
      totalTokens: acc.totalTokens + summary.totalTokens,
      uncachedInputTokens:
        acc.uncachedInputTokens + summary.uncachedInputTokens,
      unpricedUsageLineCount:
        acc.unpricedUsageLineCount + summary.unpricedUsageLineCount,
      updatedAt: Math.max(acc.updatedAt, summary.updatedAt),
      usageLineCount: acc.usageLineCount + summary.usageLineCount,
    }),
    { ...first },
  );
}

export type PricingRunningLineTotals = {
  creditMicros?: number;
  runningHasEstimate?: boolean;
  runningCostMicros: number;
  runningCreditMicros?: number;
};

export function buildPricingRunningTotals(lines: PricingUsageLine[]): {
  byLineId: Map<string, PricingRunningLineTotals>;
  hasEstimatedRows: boolean;
  totalCreditMicros: number;
} {
  const sortedLines = [...lines].sort(compareUsageLinesAscending);
  const byLineId = new Map<string, PricingRunningLineTotals>();
  let hasEstimatedRows = false;
  let runningCostMicros = 0;
  let runningCreditMicros = 0;
  for (const line of sortedLines) {
    const estimate = estimateCodexCreditsForLine(line);
    if (isEstimatedUsageGap(line)) {
      hasEstimatedRows = true;
    }
    if (line.priceStatus === "priced") {
      runningCostMicros += Math.max(0, line.totalCostMicros);
    }
    if (estimate) {
      runningCreditMicros += estimate.totalCreditMicros;
    }
    byLineId.set(line.usageLineId, {
      ...(estimate ? { creditMicros: estimate.totalCreditMicros } : {}),
      ...(hasEstimatedRows ? { runningHasEstimate: true } : {}),
      runningCostMicros,
      ...(runningCreditMicros > 0 ? { runningCreditMicros } : {}),
    });
  }
  return {
    byLineId,
    hasEstimatedRows,
    totalCreditMicros: runningCreditMicros,
  };
}

export function estimateCodexCreditsForLine(line: PricingUsageLine):
  | {
      totalCreditMicros: number;
    }
  | undefined {
  if (line.provider !== "openai") {
    return undefined;
  }
  // Inherited fork context was billed on the parent thread; never estimate
  // (and never accumulate) credits for it on the fork.
  if (isForkBaselineLine(line)) {
    return undefined;
  }
  const estimate = estimateOpenAiCodexCreditUsage({
    at: line.createdAt,
    cachedInputTokens: line.cachedInputTokens,
    fastMode: line.fastMode,
    model: line.model,
    outputTokens: line.outputTokens,
    reasoningOutputTokens: line.reasoningOutputTokens,
    serviceTier: line.serviceTier,
    uncachedInputTokens: line.uncachedInputTokens,
  });
  return estimate ? { totalCreditMicros: estimate.totalCreditMicros } : undefined;
}

/** Owner-prepared rail data. Totals include history outside this page. */
export function buildThreadPricingDisplay(params: {
  pricing?: { compactions?: ThreadCompactionRecord[]; lines: ThreadUsageLineRecord[]; summaries: ThreadPricingSummary[] };
  subAgents?: ThreadSubAgentSummary[];
  tokenMiserAccounting?: ThreadTokenMiserAccounting;
  activeTurnId?: string;
  threadReasoningEffort?: string;
  turnFailures?: readonly ThreadTurnFailure[];
  offset?: number;
  limit?: number;
  deferGates?: boolean;
  gateSelection?: PricingGateSelection;
}) {
  const summaries = params.pricing?.summaries ?? [];
  const allDisplayLines = buildPricingDisplayLines(params.pricing?.lines ?? []);
  const subAgentsById = new Map((params.subAgents ?? []).map((agent) => [agent.monitorId, agent]));
  const { displayLines, gateLinesByTurn, orphanGroupsByAnchor } = partitionTokenMiserGateLines(allDisplayLines, subAgentsById);
  const summary = aggregateSummaries(addEstimatedLinesToSummaries(summaries, allDisplayLines.filter(isEstimatedUsageGap)))
    ?? aggregateUsageLines(allDisplayLines);
  const totals = buildPricingRunningTotals(allDisplayLines);
  const compactionsByRow = groupCompactionsByRow(params.pricing?.compactions ?? []);
  const claimedCompactionTurns = new Set<string>();
  const gatesForLine = (line: PricingUsageLine) => orphanGroupsByAnchor.get(line.usageLineId)
    ?? (line.scope !== "monitor" && line.turnId ? gateLinesByTurn.get(line.turnId) ?? [] : []);
  const buildRow = (line: PricingUsageLine, nested = false): PricingUsageRowData => {
    const orphanGroup = nested ? undefined : orphanGroupsByAnchor.get(line.usageLineId);
    const gates = nested ? [] : gatesForLine(line);
    const isActive = isActiveUsageLine({ activeTurnId: params.activeTurnId, line, subAgentsById });
    const decisions = gates.length === 0 ? undefined : orphanGroup
      ? tokenMiserDecisionsForGateLines({ accounting: params.tokenMiserAccounting, gates, subAgentsById })
      : tokenMiserDecisionsForTurn(params.tokenMiserAccounting, line.turnId);
    return {
      line, nested, orphan: Boolean(orphanGroup), isActive,
      lineTotals: totals.byLineId.get(line.usageLineId),
      rowCompactions: selectRowCompactions(compactionsByRow, line, claimedCompactionTurns),
      subAgent: pricingSubAgent(line.scope === "monitor" && line.sourceItemId ? subAgentsById.get(line.sourceItemId) : undefined),
      turnFailure: !isActive && line.scope === "turn" ? params.turnFailures?.find((failure) => failure.turnId === line.turnId) : undefined,
      threadReasoningEffort: isActive && line.scope !== "monitor" ? params.threadReasoningEffort : undefined,
      decisions: params.deferGates ? undefined : decisions?.map(({ decisionSource, disposition }) => ({ decisionSource, disposition })),
      ...(gates.length ? { gateSummary: buildPricingGateGroupDisplay({ gates, subAgentsById, decisions }) } : {}),
      ...(params.deferGates && gates.length ? { gatesDeferred: true as const } : {}),
      gates: params.deferGates ? [] : gates.map((gate) => buildRow(gate, true)),
    };
  };
  let pageLines = displayLines;
  if (params.gateSelection) {
    const anchor = displayLines.find((line) => line.usageLineId === params.gateSelection!.usageLineId);
    // A live owner can remove an orphan anchor after its parent usage arrives.
    // An empty page lets the next parent refresh replace that obsolete group.
    const groups = partitionPricingGateCards(anchor ? gatesForLine(anchor) : [], subAgentsById);
    pageLines = groups[params.gateSelection.filter];
  }
  const offset = params.offset ?? 0;
  // Earlier rows still claim their compactions when reading a later page.
  for (const line of pageLines.slice(0, offset)) selectRowCompactions(compactionsByRow, line, claimedCompactionTurns);
  return {
    summary,
    spendByModel: buildPricingSpendByModel({
      lines: allDisplayLines,
      resolveModel: (line) => resolveUsageLineModel(line, line.scope === "monitor" && line.sourceItemId ? subAgentsById.get(line.sourceItemId) : undefined),
    }),
    tokenMiserSummary: buildTokenMiserSavingsSummary({
      accounting: params.tokenMiserAccounting,
      gateAccountings: (params.subAgents ?? []).filter((agent) => agent.monitorId.startsWith(TOKEN_MISER_SOURCE_PREFIX)).map((agent) => agent.tokenMiserAccounting),
    }),
    observedCostMicros: summaries.reduce((total, provider) => total + provider.totalCostMicros, 0),
    totals: { hasEstimatedRows: totals.hasEstimatedRows, totalCreditMicros: totals.totalCreditMicros },
    rows: pageLines.slice(offset, params.limit === undefined ? undefined : offset + params.limit).map((line) => buildRow(line, params.gateSelection !== undefined)),
    totalRows: pageLines.length,
  };
}

export type ThreadPricingDisplay = ReturnType<typeof buildThreadPricingDisplay>;
