import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";
import { PopoutIcon } from "../../../icons";
import {
  describeSameTrajectoryCostChange,
  type TokenMiserSavingsSummary,
} from "../token-miser-savings-summary";
import { formatCompactCount, RailSummaryRow } from "./context-rail-shared";

/**
 * What the gate did for this thread's bill, once, at the top of the Pricing
 * rail.
 *
 * The per-turn folds below already price each turn's decisions, but a thread
 * with ninety of them answers "did Token Miser pay for itself" only by
 * expanding ninety folds and adding up. This card is that addition, in the
 * savings lens's own vocabulary — same three terms, same "estimated
 * same-trajectory" framing — so an operator reading the rail and an operator
 * reading the window are reading one story.
 */
export function TokenMiserSummaryCard(props: {
  /** The thread's own billed total, for the "would have cost" comparison. */
  observedCostMicros?: number;
  onOpenSavings?: () => void;
  summary: TokenMiserSavingsSummary;
}) {
  const summary = props.summary;
  const terms = summary.terms;
  const savingsMicros = terms?.savingsMicros;
  const negative = savingsMicros !== undefined && savingsMicros < 0;
  const costChange =
    savingsMicros !== undefined && props.observedCostMicros
      ? describeSameTrajectoryCostChange(props.observedCostMicros, savingsMicros)
      : undefined;
  const unpricedCount = summary.decisionCount - summary.pricedDecisionCount;

  return (
    <div className="rail-summary-card token-miser-summary-card">
      <div className="rail-summary-card__header">
        <span className="rail-summary-card__eyebrow">Token Miser</span>
        <span className="rail-summary-card__meta">
          {summary.decisionCount.toLocaleString()} decision
          {summary.decisionCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="rail-summary-card__headline">
        <span
          className="rail-summary-card__primary token-miser-summary-card__figure"
          data-negative={negative}
        >
          {formatHeadline(summary)}
        </span>
        {/* The percentage is the popup's, trimmed to the two words the rail has
            room for. Its long form stays under the headline as the caption. */}
        {costChange ? (
          <span className="rail-summary-card__secondary">
            {costChange.split(" than ")[0]}
          </span>
        ) : null}
      </div>
      <div className="rail-summary-card__caption">
        {describeCaption({
          observedCostMicros: props.observedCostMicros,
          savingsMicros,
        })}
      </div>
      {terms ? (
        <div className="rail-summary-card__section">
          <span className="rail-summary-card__section-title">
            {unpricedCount > 0
              ? `Savings terms · ${summary.pricedDecisionCount.toLocaleString()} of ${summary.decisionCount.toLocaleString()} priced`
              : "Savings terms"}
          </span>
          <RailSummaryRow
            label="1 · Without the gate"
            value={formatTokenUsageMicrosAsUsd(terms.withoutGateCostMicros)}
          />
          <RailSummaryRow
            label="2 · Gate compute"
            value={formatTokenUsageMicrosAsUsd(terms.gateCostMicros)}
          />
          <RailSummaryRow
            label="3 · Revealed to parent"
            value={formatTokenUsageMicrosAsUsd(terms.revealedCostMicros)}
          />
        </div>
      ) : null}
      {summary.summarizedCount !== undefined
      || summary.avoidedParentTokens !== undefined ? (
        <div className="rail-summary-card__section">
          <span className="rail-summary-card__section-title">Decisions</span>
          {summary.summarizedCount !== undefined ? (
            <RailSummaryRow
              label="Summarized"
              value={summary.summarizedCount.toLocaleString()}
            />
          ) : null}
          {summary.passThroughCount !== undefined ? (
            <RailSummaryRow
              label="Passed through"
              value={summary.passThroughCount.toLocaleString()}
            />
          ) : null}
          {summary.helperDecisionCount !== undefined ? (
            <RailSummaryRow
              label="Luna evaluations"
              value={summary.helperDecisionCount.toLocaleString()}
            />
          ) : null}
          {summary.avoidedParentTokens !== undefined ? (
            <RailSummaryRow
              label="Parent context avoided"
              value={formatCompactCount(summary.avoidedParentTokens)}
            />
          ) : null}
        </div>
      ) : null}
      {props.onOpenSavings ? (
        <button
          className="token-miser-summary-card__action"
          onClick={props.onOpenSavings}
          type="button"
        >
          <PopoutIcon size={11} aria-hidden="true" />
          Token Miser Savings
        </button>
      ) : null}
    </div>
  );
}

/**
 * Dollars when the gate has priced, tokens when it has not. A thread mid-turn
 * has real decisions and no rates yet, and "$0.00 saved" would be a lie about
 * a number that simply has not arrived.
 */
function formatHeadline(summary: TokenMiserSavingsSummary): string {
  const savingsMicros = summary.terms?.savingsMicros;
  if (savingsMicros === undefined) {
    return summary.avoidedParentTokens === undefined
      ? `${summary.decisionCount.toLocaleString()} gated`
      : `${formatCompactCount(summary.avoidedParentTokens)} kept out`;
  }
  return savingsMicros >= 0
    ? `${formatTokenUsageMicrosAsUsd(savingsMicros)} saved`
    : `${formatTokenUsageMicrosAsUsd(Math.abs(savingsMicros))} net overhead`;
}

function describeCaption(params: {
  observedCostMicros?: number;
  savingsMicros?: number;
}): string {
  if (params.savingsMicros === undefined) {
    return "Dollar terms appear once each gate's usage line is priced";
  }
  const framing = params.savingsMicros >= 0
    ? "Estimated same-trajectory savings"
    : "Estimated same-trajectory overhead";
  if (!params.observedCostMicros) return framing;
  return `${framing} · ${formatTokenUsageMicrosAsUsd(
    params.observedCostMicros + params.savingsMicros,
  )} unfiltered`;
}
