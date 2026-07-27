import type {
  ThreadPricingSummary,
  ThreadSubAgentStatus,
  ThreadSubAgentSummary,
  ThreadToolAccounting,
  ThreadToolInvocationRecord,
  ThreadToolInvocationSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  estimateOpenAiCodexCreditUsage,
  estimateTokenUsageCost,
  formatTokenUsageMicrosAsUsd,
} from "@pwragent/shared";
import { useEffect, useState } from "react";
import {
  formatDurationMs,
  formatRunningDurationMs,
} from "../../../lib/format-duration";
import { formatTimestamp } from "./context-rail-shared";
import { formatTokenCount } from "./subagent-format";

type PricingPanelProps = {
  activeTurnId?: string;
  displayOptions?: PricingDisplayOptions;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
  toolAccounting?: ThreadToolAccounting;
  /**
   * Durable sub-agent (task-monitor) summaries for this thread, joined to
   * monitor-scope usage rows by `monitorId` === the row's `sourceItemId`.
   * Supplies each sub-agent row's name and its live/terminal status.
   */
  subAgents?: ThreadSubAgentSummary[];
};

// Terminal sub-agent statuses — a sub-agent in any other status is still
// running, so its usage row reads as live. Mirrors the main process
// `codexNativeSubAgentIsTerminal`.
const SUBAGENT_TERMINAL_STATUSES: ReadonlySet<ThreadSubAgentStatus> = new Set([
  "success",
  "failure",
  "cancelled",
]);

type PricingDisplayOptions = {
  codexCredits: boolean;
  usd: boolean;
};

type PricingUsageLine = ThreadUsageLineRecord & {
  estimatedUsageGap?: true;
};

const DEFAULT_PRICING_DISPLAY_OPTIONS: PricingDisplayOptions = {
  codexCredits: false,
  usd: true,
};

export function PricingPanel(props: PricingPanelProps) {
  const summaries = props.pricing?.summaries ?? [];
  const lines = props.pricing?.lines ?? [];
  const displayLines = buildPricingDisplayLines(lines);
  const estimatedLines = displayLines.filter(isEstimatedUsageGap);
  const displaySummaries = addEstimatedLinesToSummaries(summaries, estimatedLines);
  const summary =
    aggregateSummaries(displaySummaries) ?? aggregateUsageLines(displayLines);
  const displayOptions = props.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  const pricingTotals = buildPricingRunningTotals(displayLines);
  const toolTotals = aggregateToolAccounting(props.toolAccounting);
  const activeTurnId = props.activeTurnId;
  const subAgentsById = new Map(
    (props.subAgents ?? []).map((subAgent) => [subAgent.monitorId, subAgent]),
  );
  const hasActiveRow = displayLines.some((line) =>
    isActiveUsageLine({ activeTurnId, line, subAgentsById }),
  );
  // Tick while any row is live — the main turn or any still-running sub-agent —
  // so completed threads render static and never spin a 1s interval.
  const now = useNowWhileActive(hasActiveRow);

  return (
    <section className="context-panel__section">
      <h3>Pricing</h3>
      {summary ? (
        <>
          <dl className="context-grid">
            <dt>Running total</dt>
            <dd>
              {formatSummaryEstimates({
                codexCreditMicros: pricingTotals.totalCreditMicros,
                displayOptions,
                hasEstimates: pricingTotals.hasEstimatedRows,
                summary,
              })}
            </dd>
            <dt>Usage rows</dt>
            <dd>
              {summary.usageLineCount.toLocaleString()}{" "}
              <span className="context-list__meta">
                ({summary.pricedUsageLineCount.toLocaleString()} priced,{" "}
                {summary.unpricedUsageLineCount.toLocaleString()} unpriced)
              </span>
            </dd>
            <dt>Input</dt>
            <dd>
              {formatTokenCount(summary.uncachedInputTokens)} uncached,{" "}
              {formatTokenCount(summary.cachedInputTokens)} cached
            </dd>
            <dt>Output</dt>
            <dd>
              {formatTokenCount(summary.outputTokens)}
              {summary.reasoningOutputTokens > 0
                ? ` (${formatTokenCount(summary.reasoningOutputTokens)} reasoning)`
                : ""}
            </dd>
            <dt>Updated</dt>
            <dd>{formatTimestamp(summary.updatedAt)}</dd>
          </dl>
          {summary.unpricedUsageLineCount > 0 ? (
            <p className="context-empty context-empty--warning">
              {summary.unpricedUsageLineCount.toLocaleString()} usage row
              {summary.unpricedUsageLineCount === 1 ? "" : "s"} could not be priced.
            </p>
          ) : null}
          {displaySummaries.length > 1 ? (
            <ul className="context-list context-list--cards pricing-provider-list">
              {displaySummaries.map((providerSummary) => (
                <li
                  key={`${providerSummary.provider}:${providerSummary.currency}`}
                  className="rail-card pricing-provider-row"
                >
                  <p className="rail-card__title">
                    {providerSummary.provider} · {providerSummary.currency}
                  </p>
                  <p className="rail-card__usage">
                    {formatMoney(
                      providerSummary.totalCostMicros,
                      providerSummary.currency,
                    )}{" "}
                    list price · {providerSummary.usageLineCount.toLocaleString()} row
                    {providerSummary.usageLineCount === 1 ? "" : "s"}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : displayLines.length === 0 ? (
        <p className="context-empty">No usage pricing recorded yet.</p>
      ) : null}

      {toolTotals ? (
        <div className="pricing-tool-output">
          <h4>Tool output</h4>
          <dl className="context-grid">
            <dt>Estimated output tokens</dt>
            <dd>{formatTokenCount(toolTotals.estimatedOutputTokens)}</dd>
            <dt>Output volume</dt>
            <dd>
              {formatCharacterCount(toolTotals.outputChars)} ·{" "}
              {toolTotals.outputLines.toLocaleString()} lines
            </dd>
            <dt>Invocations</dt>
            <dd>
              {toolTotals.invocationCount.toLocaleString()}
              {toolTotals.noisyInvocationCount > 0 ? (
                <span className="context-list__meta">
                  {" "}
                  ({toolTotals.noisyInvocationCount.toLocaleString()} noisy)
                </span>
              ) : null}
            </dd>
            <dt>Warnings / errors</dt>
            <dd>
              {toolTotals.warningLines.toLocaleString()} /{" "}
              {toolTotals.errorLines.toLocaleString()}
            </dd>
          </dl>
          {props.toolAccounting?.alerts.length ? (
            <ul className="context-list context-list--cards pricing-tool-alert-list">
              {props.toolAccounting.alerts.map((alert) => (
                <li
                  key={alert.alertId}
                  className="rail-card pricing-tool-alert"
                >
                  <p className="rail-card__title">Noisy polling detected</p>
                  <p className="rail-card__usage">{alert.message}</p>
                  <p className="rail-card__usage">
                    Suggested steering: {alert.suggestedPrompt}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {props.toolAccounting?.summaries.length ? (
            <ul className="context-list context-list--cards pricing-tool-summary-list">
              {props.toolAccounting.summaries.slice(0, 6).map((summary) => (
                <li
                  key={`${summary.category}:${summary.toolName}`}
                  className="rail-card pricing-tool-summary-row"
                >
                  <p className="rail-card__title">
                    {formatToolSummaryTitle(summary)}
                  </p>
                  <p className="rail-card__usage">
                    {formatTokenCount(summary.estimatedOutputTokens)} est. output tokens ·{" "}
                    {formatCharacterCount(summary.outputChars)}
                  </p>
                  <p className="rail-card__usage">
                    {summary.invocationCount.toLocaleString()} invocation
                    {summary.invocationCount === 1 ? "" : "s"} ·{" "}
                    {summary.warningLines.toLocaleString()} warn ·{" "}
                    {summary.errorLines.toLocaleString()} error ·{" "}
                    {(summary.infoLines + summary.debugLines).toLocaleString()} info/debug
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {props.toolAccounting?.invocations.length ? (
            <ul className="context-list context-list--cards pricing-tool-invocation-list">
              {props.toolAccounting.invocations.slice(0, 8).map((invocation) => (
                <li
                  key={invocation.invocationId}
                  className={`rail-card pricing-tool-invocation-row${
                    invocation.noisy ? " pricing-tool-invocation-row--noisy" : ""
                  }`}
                >
                  <p className="rail-card__title">
                    {invocation.normalizedCommand ?? invocation.toolName}
                  </p>
                  <p className="rail-card__model">
                    {invocation.toolName} · {invocation.category} ·{" "}
                    {invocation.status}
                    {invocation.exitCode !== undefined
                      ? ` · exit ${invocation.exitCode}`
                      : ""}
                  </p>
                  <p className="rail-card__usage">
                    {formatTokenCount(invocation.estimatedOutputTokens)} est. output tokens ·{" "}
                    {formatCharacterCount(invocation.outputChars)} ·{" "}
                    {invocation.outputLines.toLocaleString()} lines
                    {invocation.outputTruncated ? " · truncated" : ""}
                    {invocation.noisy ? " · noisy" : ""}
                  </p>
                  <p className="rail-card__usage">
                    {invocation.warningLines.toLocaleString()} warn ·{" "}
                    {invocation.errorLines.toLocaleString()} error ·{" "}
                    {invocation.infoLines.toLocaleString()} info ·{" "}
                    {invocation.debugLines.toLocaleString()} debug
                  </p>
                  <ToolInvocationTimestamp
                    invocation={invocation}
                    onScrollToTurn={props.onScrollToTurn}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {displayLines.length > 0 ? (
        <ul className="context-list context-list--cards pricing-usage-list">
          {displayLines.map((line) => {
            const lineTotals = pricingTotals.byLineId.get(line.usageLineId);
            const usageLineEstimate = formatUsageLineEstimates({
              displayOptions,
              line,
              lineTotals,
            });
            const runningTotal = formatUsageLineRunningTotal({
              displayOptions,
              line,
              lineTotals,
            });
            const contextReplayLines = formatContextReplayEstimate({
              displayOptions,
              line,
            });
            const runningTokens = formatUsageLineRunningTokens(line);
            const subAgent =
              line.scope === "monitor" && line.sourceItemId
                ? subAgentsById.get(line.sourceItemId)
                : undefined;
            const isActive = isActiveUsageLine({ activeTurnId, line, subAgentsById });
            const duration = formatUsageLineDuration({ isActive, line, now });

            return (
              <li
                key={line.usageLineId}
                className={`rail-card pricing-usage-row${
                  isActive ? " pricing-usage-row--active" : ""
                }`}
              >
                <div className="pricing-usage-row__header">
                  <p className="rail-card__title">
                    {formatUsageLineTitle(line)}
                  </p>
                  {isActive ? (
                    <span className="rail-chip pricing-usage-row__live">
                      <span
                        className="rail-chip__dot rail-chip__dot--active"
                        aria-hidden="true"
                      />
                      Live
                    </span>
                  ) : null}
                </div>
                {subAgent?.agentName ? (
                  <p className="rail-card__agent-name" title={subAgent.agentName}>
                    {subAgent.agentName}
                  </p>
                ) : null}
                <p className="rail-card__model">
                  {line.model ?? "Unknown model"}
                  {line.reasoningEffort ? ` · ${line.reasoningEffort}` : ""}
                  {formatServiceTierLabel(line)}
                </p>
                <p className="rail-card__usage">
                  {formatTokenCount(line.uncachedInputTokens)} uncached in ·{" "}
                  {formatTokenCount(line.cachedInputTokens)} cached ·{" "}
                  {formatTokenCount(line.outputTokens)} out
                  {line.reasoningOutputTokens > 0
                    ? ` (${formatTokenCount(line.reasoningOutputTokens)} reasoning)`
                    : ""}
                </p>
                <PricingUsageTimestamp
                  duration={duration}
                  line={line}
                  onScrollToTurn={props.onScrollToTurn}
                />
                {usageLineEstimate ? (
                  <p className="rail-card__usage">{usageLineEstimate}</p>
                ) : null}
                {contextReplayLines.map((replayLine) => (
                  <p key={replayLine} className="rail-card__usage">
                    {replayLine}
                  </p>
                ))}
                {runningTokens ? (
                  <details className="pricing-running-total">
                    <summary className="pricing-running-total__summary">
                      {runningTotal ?? "Running total"}
                    </summary>
                    <p className="rail-card__usage pricing-running-total__tokens">
                      {runningTokens}
                    </p>
                  </details>
                ) : runningTotal ? (
                  <p className="rail-card__usage">{runningTotal}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

type ToolAccountingTotals = {
  debugLines: number;
  errorLines: number;
  estimatedOutputTokens: number;
  infoLines: number;
  invocationCount: number;
  noisyInvocationCount: number;
  outputChars: number;
  outputLines: number;
  warningLines: number;
};

function aggregateToolAccounting(
  toolAccounting: ThreadToolAccounting | undefined,
): ToolAccountingTotals | undefined {
  if (!toolAccounting || toolAccounting.summaries.length === 0) {
    return undefined;
  }
  return toolAccounting.summaries.reduce<ToolAccountingTotals>(
    (totals, summary) => ({
      debugLines: totals.debugLines + summary.debugLines,
      errorLines: totals.errorLines + summary.errorLines,
      estimatedOutputTokens:
        totals.estimatedOutputTokens + summary.estimatedOutputTokens,
      infoLines: totals.infoLines + summary.infoLines,
      invocationCount: totals.invocationCount + summary.invocationCount,
      noisyInvocationCount:
        totals.noisyInvocationCount + summary.noisyInvocationCount,
      outputChars: totals.outputChars + summary.outputChars,
      outputLines: totals.outputLines + summary.outputLines,
      warningLines: totals.warningLines + summary.warningLines,
    }),
    {
      debugLines: 0,
      errorLines: 0,
      estimatedOutputTokens: 0,
      infoLines: 0,
      invocationCount: 0,
      noisyInvocationCount: 0,
      outputChars: 0,
      outputLines: 0,
      warningLines: 0,
    },
  );
}

function formatToolSummaryTitle(summary: ThreadToolInvocationSummary): string {
  return `${summary.toolName} · ${summary.category}`;
}

function formatCharacterCount(chars: number): string {
  if (chars >= 1_000_000) {
    return `${(chars / 1_000_000).toFixed(chars >= 10_000_000 ? 0 : 1)}M chars`;
  }
  if (chars >= 1_000) {
    return `${(chars / 1_000).toFixed(chars >= 10_000 ? 0 : 1)}k chars`;
  }
  return `${chars.toLocaleString()} chars`;
}

function ToolInvocationTimestamp(props: {
  invocation: ThreadToolInvocationRecord;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
}) {
  const timestamp = formatTimestamp(props.invocation.observedAt);
  const canScrollToTurn = Boolean(props.invocation.turnId && props.onScrollToTurn);

  return (
    <p className="rail-card__times">
      {canScrollToTurn ? (
        <button
          type="button"
          className="rail-card__time-button"
          title="Scroll the transcript to this turn"
          aria-label={`Scroll the transcript to this turn (${timestamp})`}
          onClick={() =>
            props.invocation.turnId &&
            props.onScrollToTurn?.(
              props.invocation.turnId,
              props.invocation.observedAt,
            )
          }
        >
          {timestamp}
        </button>
      ) : (
        timestamp
      )}
      {props.invocation.turnId ? ` · ${props.invocation.turnId}` : ""}
    </p>
  );
}

function formatServiceTierLabel(line: ThreadUsageLineRecord): string {
  if (line.fastMode || line.serviceTier === "priority") {
    return " · Fast";
  }
  if (!line.serviceTier || line.serviceTier === "standard") {
    return "";
  }
  return ` · ${line.serviceTier}`;
}

function buildPricingDisplayLines(lines: ThreadUsageLineRecord[]): PricingUsageLine[] {
  const chronologicalLines = [...lines].sort(compareUsageLinesAscending);
  const displayLines: PricingUsageLine[] = [];
  let accountedMainTokens = emptyPricingTokenBreakdown();

  for (const line of chronologicalLines) {
    if (!isMainThreadUsageLine(line)) {
      displayLines.push(line);
      continue;
    }

    const cumulativeTokens = readCumulativeTokenBreakdown(line);
    const lineTokens = tokenBreakdownFromUsageLine(line);
    const gapTokens = cumulativeTokens
      ? subtractPricingTokenBreakdowns(
          cumulativeTokens,
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
        )
      : emptyPricingTokenBreakdown();
    const gapLine = hasPricingTokenBreakdownValue(gapTokens)
      ? buildEstimatedHistoricalGapLine({
          anchorLine: line,
          gapTokens,
        })
      : undefined;
    if (gapLine) {
      displayLines.push(gapLine);
      accountedMainTokens = addPricingTokenBreakdowns(accountedMainTokens, gapTokens);
    }

    displayLines.push(line);
    accountedMainTokens = cumulativeTokens
      ? maxPricingTokenBreakdowns(
          addPricingTokenBreakdowns(accountedMainTokens, lineTokens),
          cumulativeTokens,
        )
      : addPricingTokenBreakdowns(accountedMainTokens, lineTokens);
  }

  return displayLines.sort(compareUsageLinesDescending);
}

function addEstimatedLinesToSummaries(
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
    const existing =
      byKey.get(key) ??
      ({
        backend: line.backend,
        cachedInputTokens: 0,
        currency: line.currency,
        inputTokens: 0,
        outputTokens: 0,
        pricedUsageLineCount: 0,
        provider: line.provider,
        reasoningOutputTokens: 0,
        threadId: line.parentThreadId ?? line.threadId,
        totalCostMicros: 0,
        totalTokens: 0,
        uncachedInputTokens: 0,
        unpricedUsageLineCount: 0,
        updatedAt: 0,
        usageLineCount: 0,
      } satisfies ThreadPricingSummary);
    byKey.set(key, addUsageLineToSummary(existing, line));
  }
  return [...byKey.values()].sort((left, right) => {
    const providerCompare = left.provider.localeCompare(right.provider);
    return providerCompare !== 0
      ? providerCompare
      : left.currency.localeCompare(right.currency);
  });
}

function aggregateUsageLines(lines: PricingUsageLine[]): ThreadPricingSummary | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const firstLine = lines[0];
  return lines.reduce<ThreadPricingSummary>(
    (summary, line) => addUsageLineToSummary(summary, line),
    {
      backend: firstLine.backend,
      cachedInputTokens: 0,
      currency: firstLine.currency,
      inputTokens: 0,
      outputTokens: 0,
      pricedUsageLineCount: 0,
      provider: firstLine.provider,
      reasoningOutputTokens: 0,
      threadId: firstLine.threadId,
      totalCostMicros: 0,
      totalTokens: 0,
      uncachedInputTokens: 0,
      unpricedUsageLineCount: 0,
      updatedAt: 0,
      usageLineCount: 0,
    },
  );
}

type PricingTokenBreakdown = {
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  uncachedInputTokens: number;
};

function addUsageLineToSummary(
  summary: ThreadPricingSummary,
  line: PricingUsageLine,
): ThreadPricingSummary {
  return {
    backend: summary.backend,
    cachedInputTokens: summary.cachedInputTokens + line.cachedInputTokens,
    currency: summary.currency,
    inputTokens: summary.inputTokens + line.inputTokens,
    outputTokens: summary.outputTokens + line.outputTokens,
    pricedUsageLineCount:
      summary.pricedUsageLineCount + (line.priceStatus === "priced" ? 1 : 0),
    provider: summary.provider,
    reasoningOutputTokens:
      summary.reasoningOutputTokens + line.reasoningOutputTokens,
    threadId: summary.threadId,
    totalCostMicros: summary.totalCostMicros + line.totalCostMicros,
    totalTokens: summary.totalTokens + line.totalTokens,
    uncachedInputTokens: summary.uncachedInputTokens + line.uncachedInputTokens,
    unpricedUsageLineCount:
      summary.unpricedUsageLineCount + (line.priceStatus === "priced" ? 0 : 1),
    updatedAt: Math.max(summary.updatedAt, line.completedAt ?? line.createdAt),
    usageLineCount: summary.usageLineCount + 1,
  };
}

function summaryKey(summary: ThreadPricingSummary): string {
  return [
    summary.backend,
    summary.threadId,
    summary.provider,
    summary.currency,
  ].join(":");
}

function usageLineSummaryKey(line: PricingUsageLine): string {
  return [
    line.backend,
    line.parentThreadId ?? line.threadId,
    line.provider,
    line.currency,
  ].join(":");
}

function compareUsageLinesAscending(
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

function compareUsageLinesDescending(
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

function lineSortTimestamp(line: ThreadUsageLineRecord): number {
  return line.startedAt ?? line.createdAt;
}

function emptyPricingTokenBreakdown(): PricingTokenBreakdown {
  return {
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    uncachedInputTokens: 0,
  };
}

function tokenBreakdownFromUsageLine(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, line.cachedInputTokens),
    outputTokens: Math.max(0, line.outputTokens),
    reasoningOutputTokens: Math.max(0, line.reasoningOutputTokens),
    uncachedInputTokens: Math.max(0, line.uncachedInputTokens),
  };
}

function readCumulativeTokenBreakdown(
  line: ThreadUsageLineRecord,
): PricingTokenBreakdown | undefined {
  if (!hasCumulativeTokenBreakdown(line)) {
    return undefined;
  }
  const uncachedInputTokens = readCumulativeUncachedInputTokens(line);
  if (
    uncachedInputTokens === undefined ||
    line.cumulativeCachedInputTokens === undefined ||
    line.cumulativeOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    cachedInputTokens: Math.max(0, line.cumulativeCachedInputTokens),
    outputTokens: Math.max(0, line.cumulativeOutputTokens),
    reasoningOutputTokens: Math.max(0, line.cumulativeReasoningOutputTokens ?? 0),
    uncachedInputTokens: Math.max(0, uncachedInputTokens),
  };
}

function addPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
  };
}

function subtractPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(0, left.cachedInputTokens - right.cachedInputTokens),
    outputTokens: Math.max(0, left.outputTokens - right.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      left.reasoningOutputTokens - right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      0,
      left.uncachedInputTokens - right.uncachedInputTokens,
    ),
  };
}

function maxPricingTokenBreakdowns(
  left: PricingTokenBreakdown,
  right: PricingTokenBreakdown,
): PricingTokenBreakdown {
  return {
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(
      left.reasoningOutputTokens,
      right.reasoningOutputTokens,
    ),
    uncachedInputTokens: Math.max(
      left.uncachedInputTokens,
      right.uncachedInputTokens,
    ),
  };
}

function hasPricingTokenBreakdownValue(tokens: PricingTokenBreakdown): boolean {
  return (
    tokens.cachedInputTokens > 0 ||
    tokens.outputTokens > 0 ||
    tokens.reasoningOutputTokens > 0 ||
    tokens.uncachedInputTokens > 0
  );
}

function isMainThreadUsageLine(line: ThreadUsageLineRecord): boolean {
  return line.scope !== "monitor";
}

function buildEstimatedHistoricalGapLine(params: {
  anchorLine: ThreadUsageLineRecord;
  gapTokens: PricingTokenBreakdown;
}): PricingUsageLine | undefined {
  const cost = estimateTokenUsageCost({
    at: params.anchorLine.createdAt,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    fastMode: false,
    model: params.anchorLine.model,
    outputTokens: params.gapTokens.outputTokens,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    serviceTier: "standard",
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
  });
  const inputTokens =
    params.gapTokens.cachedInputTokens + params.gapTokens.uncachedInputTokens;
  const totalTokens =
    inputTokens +
    params.gapTokens.outputTokens +
    params.gapTokens.reasoningOutputTokens;
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost ? undefined : params.anchorLine.model ? "missing-rate" : "missing-model";

  return {
    backend: params.anchorLine.backend,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens: params.gapTokens.cachedInputTokens,
    createdAt: Math.max(0, lineSortTimestamp(params.anchorLine) - 1),
    currency: cost?.currency ?? params.anchorLine.currency,
    estimatedUsageGap: true,
    inputTokens,
    model: params.anchorLine.model,
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens: params.gapTokens.outputTokens,
    parentThreadId: params.anchorLine.parentThreadId,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? params.anchorLine.provider,
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    reasoningEffort: params.anchorLine.reasoningEffort,
    reasoningOutputTokens: params.gapTokens.reasoningOutputTokens,
    scope: "backfill",
    serviceTier: "standard",
    settingsConfidence: "fallback",
    settingsSource: "observed-settings",
    source: "backfill",
    sourceItemId: `estimated-gap:${params.anchorLine.usageLineId}`,
    status: "finalized",
    threadId: params.anchorLine.threadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens: params.gapTokens.uncachedInputTokens,
    usageLineId: `estimated-gap:${params.anchorLine.usageLineId}`,
    usageTurnId: `estimated-gap:${params.anchorLine.usageTurnId ?? params.anchorLine.usageLineId}`,
  };
}

function formatSummaryEstimates(params: {
  codexCreditMicros: number | undefined;
  displayOptions: PricingDisplayOptions;
  hasEstimates?: boolean;
  summary: ThreadPricingSummary;
}): string {
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    estimates.push(formatMoney(params.summary.totalCostMicros, params.summary.currency));
  }
  if (
    params.displayOptions.codexCredits &&
    params.codexCreditMicros !== undefined &&
    params.codexCreditMicros > 0
  ) {
    estimates.push(formatCodexCredits(params.codexCreditMicros));
  }
  if (estimates.length > 0) {
    return `${estimates.join(" · ")}${params.hasEstimates ? " estimated" : ""}`;
  }
  return hasSelectedEstimateUnit(params.displayOptions)
    ? "No selected estimates available"
    : "No estimate units selected";
}

function formatUsageLineEstimates(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  lineTotals: PricingRunningLineTotals | undefined;
}): string | undefined {
  // Inherited fork context was billed on the parent thread — show the
  // attribution, never a dollar figure, so it reads as not-re-charged here.
  if (isForkBaselineLine(params.line)) {
    return "Inherited from parent thread — billed there, not re-charged here";
  }
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    estimates.push(
      params.line.priceStatus === "priced"
        ? `${formatMoney(params.line.totalCostMicros, params.line.currency)} ${formatUsageLineCostSuffix(params.line)}`
        : `Unpriced: ${formatUnpricedReason(params.line.priceUnavailableReason)}`,
    );
  }
  if (
    params.displayOptions.codexCredits &&
    params.lineTotals?.creditMicros !== undefined &&
    params.lineTotals.creditMicros > 0
  ) {
    const suffix = formatUsageLineCreditSuffix(params.line);
    estimates.push(
      `${formatCodexCredits(params.lineTotals.creditMicros)}${suffix ? ` ${suffix}` : ""}`,
    );
  }
  return estimates.length > 0 ? estimates.join(" · ") : undefined;
}

function formatUsageLineRunningTotal(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  lineTotals: PricingRunningLineTotals | undefined;
}): string | undefined {
  // The fork-point card carries no incremental cost, so a running-total row on
  // it is noise — the attribution line already says it isn't charged here.
  if (isForkBaselineLine(params.line)) {
    return undefined;
  }
  const estimates: string[] = [];
  if (params.displayOptions.usd && params.lineTotals?.runningCostMicros !== undefined) {
    estimates.push(
      `${formatMoney(params.lineTotals.runningCostMicros, params.line.currency)} list price`,
    );
  }
  if (
    params.displayOptions.codexCredits &&
    params.lineTotals?.runningCreditMicros !== undefined &&
    params.lineTotals.runningCreditMicros > 0
  ) {
    estimates.push(formatCodexCredits(params.lineTotals.runningCreditMicros));
  }
  return estimates.length > 0
    ? `Running total: ${estimates.join(" · ")}${params.lineTotals?.runningHasEstimate ? " (includes estimates)" : ""}`
    : undefined;
}

function formatContextReplayEstimate(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
}): string[] {
  // Context replays are observed per turn: turn-scoped lines and sub-agent
  // ("monitor") lines both carry the tally the main process accumulated live.
  // Guarding on scope keeps total/backfill/gap rows from ever rendering replay
  // estimates even if they somehow carried the fields.
  if (
    (params.line.scope !== "turn" && params.line.scope !== "monitor") ||
    isEstimatedUsageGap(params.line) ||
    isHistoricalUsageSummary(params.line)
  ) {
    return [];
  }

  const lines: string[] = [];
  for (const label of ["cold", "hot"] as const) {
    const summary = readObservedReplaySummary(params.line, label);
    if (summary) {
      lines.push(
        formatObservedReplayLine({
          displayOptions: params.displayOptions,
          line: params.line,
          summary,
        }),
      );
    }
  }
  return lines;
}

type ObservedReplaySummary = {
  count: number;
  label: "cold" | "hot";
  tokenKind: "cached" | "uncached";
  tokens: number;
};

// Replay tallies come straight from the main-process accumulator on the usage
// line — one replay per model request in the turn, classified hot/cold from
// that request's cache split. Absent fields mean the turn was not observed
// live, so we render nothing rather than inventing a bucket estimate.
function readObservedReplaySummary(
  line: PricingUsageLine,
  label: "cold" | "hot",
): ObservedReplaySummary | undefined {
  const count =
    label === "cold" ? line.observedColdReplayCount : line.observedHotReplayCount;
  if (typeof count !== "number" || count <= 0) {
    return undefined;
  }
  const tokens =
    label === "cold"
      ? line.observedColdReplayUncachedTokens ?? 0
      : line.observedHotReplayCachedTokens ?? 0;
  return {
    count,
    label,
    tokenKind: label === "cold" ? "uncached" : "cached",
    tokens,
  };
}

function formatObservedReplayLine(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): string {
  const { count, tokenKind, tokens } = params.summary;
  const replayTokens =
    count > 1
      ? `~${formatTokenCount(Math.round(tokens / count))} ${tokenKind} avg; ${formatTokenCount(
          tokens,
        )} ${tokenKind} bucket`
      : `${formatTokenCount(tokens)} ${tokenKind}`;
  return `Estimated ${params.summary.label} context replays: ${count.toLocaleString()} (${replayTokens}${formatReplayCostEstimates(
    params,
  )})`;
}

function formatReplayCostEstimates(params: {
  displayOptions: PricingDisplayOptions;
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): string {
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    const valueMicros = estimateReplayCostMicros(params);
    if (valueMicros > 0) {
      estimates.push(formatMoney(valueMicros, params.line.currency));
    }
  }
  if (params.displayOptions.codexCredits) {
    const credits = estimateContextReplayCodexCredits(params);
    if (credits !== undefined && credits > 0) {
      estimates.push(formatCodexCredits(credits));
    }
  }
  if (estimates.length === 0) {
    return "";
  }
  return ` · ${estimates.join(" · ")}`;
}

// Price the observed replay tokens as a fraction of the turn line's already-
// priced cached/uncached cost. The line's cached/uncached totals are the
// per-request sums across the turn, so the observed replay tokens are always a
// subset — the ratio attributes the share of the turn's input cost the replays
// account for.
function estimateReplayCostMicros(params: {
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): number {
  const totalTokens =
    params.summary.tokenKind === "cached"
      ? params.line.cachedInputTokens
      : params.line.uncachedInputTokens;
  const totalMicros =
    params.summary.tokenKind === "cached"
      ? params.line.cachedInputCostMicros
      : params.line.uncachedInputCostMicros;
  if (totalTokens <= 0) {
    return 0;
  }
  if (params.summary.tokens >= totalTokens) {
    return totalMicros;
  }
  return Math.round((totalMicros * params.summary.tokens) / totalTokens);
}

function estimateContextReplayCodexCredits(params: {
  line: PricingUsageLine;
  summary: ObservedReplaySummary;
}): number | undefined {
  if (params.line.provider !== "openai") {
    return undefined;
  }
  const estimate = estimateOpenAiCodexCreditUsage({
    at: params.line.createdAt,
    cachedInputTokens:
      params.summary.tokenKind === "cached" ? params.summary.tokens : 0,
    fastMode: params.line.fastMode,
    model: params.line.model,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    serviceTier: params.line.serviceTier,
    uncachedInputTokens:
      params.summary.tokenKind === "uncached" ? params.summary.tokens : 0,
  });
  return estimate?.totalCreditMicros;
}

function formatUsageLineRunningTokens(line: ThreadUsageLineRecord): string | undefined {
  if (!hasCumulativeTokenBreakdown(line)) {
    return undefined;
  }
  const uncachedInputTokens = readCumulativeUncachedInputTokens(line);
  if (
    uncachedInputTokens === undefined ||
    line.cumulativeCachedInputTokens === undefined ||
    line.cumulativeOutputTokens === undefined
  ) {
    return undefined;
  }
  const tokens = [
    `${formatTokenCount(uncachedInputTokens)} uncached in`,
    `${formatTokenCount(line.cumulativeCachedInputTokens)} cached`,
    line.cumulativeReasoningOutputTokens && line.cumulativeReasoningOutputTokens > 0
      ? `${formatTokenCount(line.cumulativeOutputTokens)} out (${formatTokenCount(
          line.cumulativeReasoningOutputTokens,
        )} reasoning)`
      : `${formatTokenCount(line.cumulativeOutputTokens)} out`,
  ].join(" · ");
  return `Running tokens: ${tokens}`;
}

function hasCumulativeTokenBreakdown(line: ThreadUsageLineRecord): boolean {
  return (
    line.cumulativeCachedInputTokens !== undefined &&
    line.cumulativeOutputTokens !== undefined &&
    readCumulativeUncachedInputTokens(line) !== undefined
  );
}

function readCumulativeUncachedInputTokens(
  line: ThreadUsageLineRecord,
): number | undefined {
  if (line.cumulativeUncachedInputTokens !== undefined) {
    return line.cumulativeUncachedInputTokens;
  }
  if (
    line.cumulativeInputTokens !== undefined &&
    line.cumulativeCachedInputTokens !== undefined
  ) {
    return Math.max(0, line.cumulativeInputTokens - line.cumulativeCachedInputTokens);
  }
  return undefined;
}

function hasSelectedEstimateUnit(displayOptions: PricingDisplayOptions): boolean {
  return displayOptions.usd || displayOptions.codexCredits;
}

function formatUsageLineTitle(line: PricingUsageLine): string {
  if (line.scope === "monitor") {
    return "Sub-agent usage";
  }
  if (isForkBaselineLine(line)) {
    return "Fork point";
  }
  if (isEstimatedUsageGap(line)) {
    return "Historical usage estimate";
  }
  if (isHistoricalUsageSummary(line)) {
    return "Historical usage summary";
  }
  if (line.scope === "latest-request") {
    return "Latest request usage";
  }
  return "Turn usage";
}

function formatUsageLineCostSuffix(line: PricingUsageLine): string {
  if (isEstimatedUsageGap(line)) {
    return "estimated list price";
  }
  if (line.scope === "latest-request") {
    return "list price this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "list price this turn";
  }
  return "list price";
}

function formatUsageLineCreditSuffix(line: PricingUsageLine): string {
  if (isEstimatedUsageGap(line)) {
    return "estimated";
  }
  if (line.scope === "latest-request") {
    return "this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "this turn";
  }
  return "";
}

function isEstimatedUsageGap(line: ThreadUsageLineRecord): boolean {
  return "estimatedUsageGap" in line && line.estimatedUsageGap === true;
}

function isForkBaselineLine(line: ThreadUsageLineRecord): boolean {
  return line.scope === "fork-baseline";
}

// A row is a whole-thread/historical summary when its scope says so, or when
// the live builder recorded that it could not attribute the usage to this turn
// (turnUsageAttributed === false) — e.g. a first observed event that carried a
// whole-thread total we couldn't decompose. Legacy rows predating the flag are
// backfilled by the state-db migration (user_version 26). No token-count guess.
function isHistoricalUsageSummary(line: ThreadUsageLineRecord): boolean {
  return (
    line.scope === "total" ||
    line.scope === "backfill" ||
    line.turnUsageAttributed === false
  );
}

// The in-progress turn: the live, still-pending turn row whose id matches the
// session's active turn. Drives the Live chip + running duration.
function isActiveLiveTurnUsageLine(params: {
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

// A row is live if it's the main active turn OR a monitor row whose sub-agent
// is still running. Sub-agents run concurrently, so more than one row can be
// live at once (e.g. a fan-out of spawn_agent calls in a single turn).
function isActiveUsageLine(params: {
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
  return Boolean(subAgent && !SUBAGENT_TERMINAL_STATUSES.has(subAgent.status));
}

function PricingUsageTimestamp(props: {
  duration?: string;
  line: ThreadUsageLineRecord;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
}) {
  const timestamp = formatTimestamp(props.line.createdAt);
  const canScrollToTurn = Boolean(props.line.turnId && props.onScrollToTurn);

  return (
    <p className="rail-card__times">
      {canScrollToTurn ? (
        <button
          type="button"
          className="rail-card__time-button"
          title="Scroll the transcript to this turn"
          aria-label={`Scroll the transcript to this turn (${timestamp})`}
          onClick={() =>
            props.line.turnId &&
            props.onScrollToTurn?.(props.line.turnId, props.line.createdAt)
          }
        >
          {timestamp}
        </button>
      ) : (
        timestamp
      )}
      {props.duration ? ` · ${props.duration}` : ""}
      {props.line.turnId ? ` · ${props.line.turnId}` : ""}
    </p>
  );
}

/**
 * The start-anchored timestamp on each card carries the "when", so the card
 * pairs it with a single duration rather than a second minute-resolution stop
 * stamp (two coarse stamps can't reconstruct a sub-minute turn anyway).
 *
 * - Live turn: elapsed since start, ticking once per second.
 * - Finished turn: completedAt − start, in the coarse `2h 3m 4s` style.
 * - Estimates / historical summaries / sub-agent rollups: no duration — the
 *   span isn't a single measurable turn.
 */
function formatUsageLineDuration(params: {
  isActive: boolean;
  line: PricingUsageLine;
  now: number;
}): string {
  const { isActive, line, now } = params;
  const start = line.startedAt ?? line.createdAt;
  // The active turn always shows its running clock: if it's wearing the Live
  // chip, the duration must agree. Checked before the scope/estimate/historical
  // guards because a live turn can trip isHistoricalUsageSummary (a >= 1M-token
  // request with no cumulative snapshot yet), which would otherwise strand the
  // Live chip with no ticking duration.
  if (isActive) {
    return formatRunningDurationMs(Math.max(0, now - start));
  }
  if (
    line.scope === "monitor" ||
    isEstimatedUsageGap(line) ||
    isHistoricalUsageSummary(line)
  ) {
    return "";
  }
  const end = line.completedAt;
  if (end === undefined || end <= start) {
    return "";
  }
  return formatDurationMs(end - start);
}

/**
 * `Date.now()` that re-renders once per second, but only while a live turn is
 * present. When nothing is active the interval is torn down, so a settled
 * pricing panel never keeps a timer running.
 */
function useNowWhileActive(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) {
      return;
    }
    setNow(Date.now());
    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [enabled]);
  return now;
}

function aggregateSummaries(
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

function formatMoney(valueMicros: number, currency: string): string {
  if (currency === "USD") {
    return formatTokenUsageMicrosAsUsd(valueMicros);
  }
  return `${currency} ${(valueMicros / 1_000_000).toFixed(4)}`;
}

type PricingRunningLineTotals = {
  creditMicros?: number;
  runningHasEstimate?: boolean;
  runningCostMicros: number;
  runningCreditMicros?: number;
};

function buildPricingRunningTotals(lines: PricingUsageLine[]): {
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

function estimateCodexCreditsForLine(line: PricingUsageLine):
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

function formatCodexCredits(valueMicros: number): string {
  if (valueMicros <= 0) {
    return "0 Codex Credits";
  }
  const value = valueMicros / 1_000_000;
  if (value < 0.05) {
    return "<0.1 Codex Credits";
  }
  if (value >= 10) {
    return `${new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 0,
    }).format(value)} Codex Credits`;
  }
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(value)} Codex Credits`;
}

function formatUnpricedReason(
  reason: ThreadUsageLineRecord["priceUnavailableReason"],
): string {
  switch (reason) {
    case "missing-model":
      return "missing model";
    case "missing-rate":
      return "missing rate";
    case "unsupported-service-tier":
      return "unsupported service tier";
    case "insufficient-token-breakdown":
      return "insufficient token breakdown";
    default:
      return "unknown reason";
  }
}
