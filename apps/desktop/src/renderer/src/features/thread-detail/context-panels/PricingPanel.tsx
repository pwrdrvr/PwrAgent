import type {
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  estimateOpenAiCodexCreditUsage,
  formatTokenUsageMicrosAsUsd,
} from "@pwragent/shared";
import { formatTimestamp } from "./context-rail-shared";
import { formatTokenCount } from "./subagent-format";

type PricingPanelProps = {
  displayOptions?: PricingDisplayOptions;
  onScrollToTurn?: (turnId: string, turnTimeMs?: number) => void;
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
};

type PricingDisplayOptions = {
  codexCredits: boolean;
  usd: boolean;
};

const DEFAULT_PRICING_DISPLAY_OPTIONS: PricingDisplayOptions = {
  codexCredits: false,
  usd: true,
};

export function PricingPanel(props: PricingPanelProps) {
  const summaries = props.pricing?.summaries ?? [];
  const lines = props.pricing?.lines ?? [];
  const summary = aggregateSummaries(summaries) ?? aggregateUsageLines(lines);
  const displayOptions = props.displayOptions ?? DEFAULT_PRICING_DISPLAY_OPTIONS;
  const codexCreditTotals = buildCodexCreditTotals(lines);

  return (
    <section className="context-panel__section">
      <h3>Pricing</h3>
      {summary ? (
        <>
          <dl className="context-grid">
            <dt>Total</dt>
            <dd>
              {formatSummaryEstimates({
                codexCreditMicros: codexCreditTotals.totalCreditMicros,
                displayOptions,
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
          {summaries.length > 1 ? (
            <ul className="context-list context-list--cards pricing-provider-list">
              {summaries.map((providerSummary) => (
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
      ) : lines.length === 0 ? (
        <p className="context-empty">No usage pricing recorded yet.</p>
      ) : null}

      {lines.length > 0 ? (
        <ul className="context-list context-list--cards pricing-usage-list">
          {lines.map((line) => {
            const creditEstimate = codexCreditTotals.byLineId.get(line.usageLineId);
            const usageLineEstimate = formatUsageLineEstimates({
              creditEstimate,
              displayOptions,
              line,
            });
            const runningTotal = formatUsageLineRunningTotal({
              creditEstimate,
              displayOptions,
              line,
            });

            return (
              <li key={line.usageLineId} className="rail-card pricing-usage-row">
                <p className="rail-card__title">
                  {formatUsageLineTitle(line)}
                </p>
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
                  line={line}
                  onScrollToTurn={props.onScrollToTurn}
                />
                {usageLineEstimate ? (
                  <p className="rail-card__usage">{usageLineEstimate}</p>
                ) : null}
                {runningTotal ? (
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

function formatServiceTierLabel(line: ThreadUsageLineRecord): string {
  if (line.fastMode || line.serviceTier === "priority") {
    return " · Fast";
  }
  if (!line.serviceTier || line.serviceTier === "standard") {
    return "";
  }
  return ` · ${line.serviceTier}`;
}

function aggregateUsageLines(lines: ThreadUsageLineRecord[]): ThreadPricingSummary | undefined {
  if (lines.length === 0) {
    return undefined;
  }
  const firstLine = lines[0];
  return lines.reduce<ThreadPricingSummary>(
    (summary, line) => ({
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
    }),
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

function formatSummaryEstimates(params: {
  codexCreditMicros: number;
  displayOptions: PricingDisplayOptions;
  summary: ThreadPricingSummary;
}): string {
  const estimates: string[] = [];
  if (params.displayOptions.usd) {
    estimates.push(formatMoney(params.summary.totalCostMicros, params.summary.currency));
  }
  if (params.displayOptions.codexCredits && params.codexCreditMicros > 0) {
    estimates.push(formatCodexCredits(params.codexCreditMicros));
  }
  if (estimates.length > 0) {
    return estimates.join(" · ");
  }
  return hasSelectedEstimateUnit(params.displayOptions)
    ? "No selected estimates available"
    : "No estimate units selected";
}

function formatUsageLineEstimates(params: {
  creditEstimate: CodexCreditLineEstimate | undefined;
  displayOptions: PricingDisplayOptions;
  line: ThreadUsageLineRecord;
}): string | undefined {
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
    params.creditEstimate &&
    params.creditEstimate.totalCreditMicros > 0
  ) {
    const suffix = formatUsageLineCreditSuffix(params.line);
    estimates.push(
      `${formatCodexCredits(params.creditEstimate.totalCreditMicros)}${suffix ? ` ${suffix}` : ""}`,
    );
  }
  return estimates.length > 0 ? estimates.join(" · ") : undefined;
}

function formatUsageLineRunningTotal(params: {
  creditEstimate: CodexCreditLineEstimate | undefined;
  displayOptions: PricingDisplayOptions;
  line: ThreadUsageLineRecord;
}): string | undefined {
  const estimates: string[] = [];
  if (
    params.displayOptions.usd &&
    params.line.cumulativeTotalCostMicros !== undefined
  ) {
    estimates.push(
      `${formatMoney(params.line.cumulativeTotalCostMicros, params.line.currency)} list price`,
    );
  }
  if (
    params.displayOptions.codexCredits &&
    params.creditEstimate &&
    params.creditEstimate.cumulativeTotalCreditMicros > 0
  ) {
    estimates.push(formatCodexCredits(params.creditEstimate.cumulativeTotalCreditMicros));
  }
  return estimates.length > 0 ? `Running total: ${estimates.join(" · ")}` : undefined;
}

function hasSelectedEstimateUnit(displayOptions: PricingDisplayOptions): boolean {
  return displayOptions.usd || displayOptions.codexCredits;
}

function formatUsageLineTitle(line: ThreadUsageLineRecord): string {
  if (line.scope === "monitor") {
    return "Sub-agent usage";
  }
  if (isHistoricalUsageSummary(line)) {
    return "Historical usage summary";
  }
  if (line.scope === "latest-request") {
    return "Latest request usage";
  }
  return "Turn usage";
}

function formatUsageLineCostSuffix(line: ThreadUsageLineRecord): string {
  if (line.scope === "latest-request") {
    return "list price this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "list price this turn";
  }
  return "list price";
}

function formatUsageLineCreditSuffix(line: ThreadUsageLineRecord): string {
  if (line.scope === "latest-request") {
    return "this request";
  }
  if (line.scope === "turn" && !isHistoricalUsageSummary(line)) {
    return "this turn";
  }
  return "";
}

function isHistoricalUsageSummary(line: ThreadUsageLineRecord): boolean {
  if (line.scope === "total" || line.scope === "backfill") {
    return true;
  }
  return (
    line.source === "live" &&
    line.status === "pending" &&
    line.cumulativeTotalTokens === undefined &&
    line.totalTokens >= 1_000_000
  );
}

function PricingUsageTimestamp(props: {
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
      {props.line.turnId ? ` · ${props.line.turnId}` : ""}
    </p>
  );
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

type CodexCreditLineEstimate = {
  cumulativeTotalCreditMicros: number;
  totalCreditMicros: number;
};

function buildCodexCreditTotals(lines: ThreadUsageLineRecord[]): {
  byLineId: Map<string, CodexCreditLineEstimate>;
  totalCreditMicros: number;
} {
  const sortedLines = [...lines].sort(
    (left, right) =>
      (left.startedAt ?? left.createdAt) - (right.startedAt ?? right.createdAt),
  );
  const byLineId = new Map<string, CodexCreditLineEstimate>();
  let totalCreditMicros = 0;
  for (const line of sortedLines) {
    const estimate = estimateCodexCreditsForLine(line);
    if (!estimate) {
      continue;
    }
    totalCreditMicros += estimate.totalCreditMicros;
    byLineId.set(line.usageLineId, {
      cumulativeTotalCreditMicros: totalCreditMicros,
      totalCreditMicros: estimate.totalCreditMicros,
    });
  }
  return { byLineId, totalCreditMicros };
}

function estimateCodexCreditsForLine(line: ThreadUsageLineRecord):
  | {
      totalCreditMicros: number;
    }
  | undefined {
  if (line.provider !== "openai") {
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
