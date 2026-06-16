import type {
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import {
  formatTokenUsageMicrosAsUsd,
} from "@pwragent/shared";
import { formatTimestamp } from "./context-rail-shared";
import { formatTokenCount } from "./subagent-format";

type PricingPanelProps = {
  pricing?: {
    lines: ThreadUsageLineRecord[];
    summaries: ThreadPricingSummary[];
  };
};

export function PricingPanel(props: PricingPanelProps) {
  const summaries = props.pricing?.summaries ?? [];
  const lines = props.pricing?.lines ?? [];
  const summary = summaries[0];

  return (
    <section className="context-panel__section">
      <h3>Pricing</h3>
      {summary ? (
        <>
          <dl className="context-grid">
            <dt>Total</dt>
            <dd>{formatMoney(summary.totalCostMicros, summary.currency)}</dd>
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
        </>
      ) : (
        <p className="context-empty">No usage pricing recorded yet.</p>
      )}

      {lines.length > 0 ? (
        <ul className="context-list context-list--cards pricing-usage-list">
          {lines.map((line) => (
            <li key={line.usageLineId} className="rail-card pricing-usage-row">
              <p className="rail-card__title">
                {line.scope === "monitor" ? "Sub-agent usage" : "Turn usage"}
              </p>
              <p className="rail-card__model">
                {line.model ?? "Unknown model"}
                {line.reasoningEffort ? ` · ${line.reasoningEffort}` : ""}
                {line.fastMode ? " · Fast" : ""}
                {line.serviceTier ? ` · ${line.serviceTier}` : ""}
              </p>
              <p className="rail-card__usage">
                {formatTokenCount(line.uncachedInputTokens)} uncached in ·{" "}
                {formatTokenCount(line.cachedInputTokens)} cached ·{" "}
                {formatTokenCount(line.outputTokens)} out
                {line.reasoningOutputTokens > 0
                  ? ` (${formatTokenCount(line.reasoningOutputTokens)} reasoning)`
                  : ""}
              </p>
              <p className="rail-card__times">
                {formatTimestamp(line.createdAt)}
                {line.turnId ? ` · ${line.turnId}` : ""}
              </p>
              <p className="rail-card__usage">
                {line.priceStatus === "priced"
                  ? `${formatMoney(line.totalCostMicros, line.currency)} list price`
                  : `Unpriced: ${formatUnpricedReason(line.priceUnavailableReason)}`}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function formatMoney(valueMicros: number, currency: string): string {
  if (currency === "USD") {
    return formatTokenUsageMicrosAsUsd(valueMicros);
  }
  return `${currency} ${(valueMicros / 1_000_000).toFixed(4)}`;
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
