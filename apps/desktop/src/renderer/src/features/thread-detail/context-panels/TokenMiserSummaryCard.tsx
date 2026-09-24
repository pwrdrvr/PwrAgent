import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";
import { PopoutIcon } from "../../../icons";
import {
  buildTokenMiserSavingsSplit,
  classifyTokenMiserSavings,
  describeSameTrajectoryCostChange,
  TOKEN_MISER_PENDING_PRICING_CAPTION,
  type TokenMiserSavingsSummary,
  type TokenMiserVerdictTier,
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
  const headline = describeHeadline(summary, props.observedCostMicros);
  // Only the dollar headline has a percentage to compare against; a thread
  // showing tokens or a bare decision count has no observed bill to divide by.
  const savingsMicros =
    summary.decisionCount > 0 ? terms?.savingsMicros : undefined;
  const costChange =
    savingsMicros !== undefined && props.observedCostMicros
      ? describeSameTrajectoryCostChange(props.observedCostMicros, savingsMicros)
      : undefined;
  const unpricedCount = summary.decisionCount - summary.pricedDecisionCount;
  // Only an exceptional result draws the bar; below that the card's shell is
  // the same as every other summary card's.
  const split =
    headline.tier === "exceptional" && terms
      ? buildTokenMiserSavingsSplit(terms)
      : undefined;

  return (
    <div
      className="rail-summary-card token-miser-summary-card"
      data-savings-tier={headline.tier}
    >
      <div className="rail-summary-card__header">
        <span className="rail-summary-card__eyebrow">Token Miser</span>
        <span className="rail-summary-card__meta">
          {summary.decisionCount.toLocaleString()} decision
          {summary.decisionCount === 1 ? "" : "s"}
        </span>
      </div>
      <div className="rail-summary-card__headline">
        <span className="rail-summary-card__primary token-miser-summary-card__figure">
          {headline.text}
        </span>
        {/* The percentage is the popup's, in the shorter of the two widths the
            comparison publishes. Its sentence stays under the headline. */}
        {costChange ? (
          <span className="rail-summary-card__secondary token-miser-summary-card__percent">
            {costChange.short}
          </span>
        ) : null}
      </div>
      {split ? (
        <>
          <span aria-hidden="true" className="token-miser-summary-card__split">
            <i data-part="avoided" style={{ width: `${split.avoided}%` }} />
            <i data-part="gate" style={{ width: `${split.gate}%` }} />
            <i data-part="revealed" style={{ width: `${split.revealed}%` }} />
          </span>
          <div className="token-miser-summary-card__split-caption">
            <b>{split.rounded.avoided}%</b> avoided
            {" · "}<b>{split.rounded.gate}%</b> gate
            {" · "}<b>{split.rounded.revealed}%</b> revealed
          </div>
        </>
      ) : null}
      <div className="rail-summary-card__caption">
        {describeCaption({
          decisionCount: summary.decisionCount,
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
      || summary.codeModeCallCount !== undefined
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
          {summary.codeModeCallCount !== undefined ? (
            <RailSummaryRow
              label="Code Mode calls"
              value={summary.codeModeCallCount.toLocaleString()}
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
          className="context-panel__section-action"
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

type TokenMiserHeadline = {
  /**
   * Where the figure sits on the verdict scale. Absent while the figure is not
   * a verdict yet: a count, or tokens kept out before pricing lands.
   */
  tier?: TokenMiserVerdictTier;
  text: string;
};

/**
 * Dollars when the gate has priced, tokens when it has not. A thread mid-turn
 * has real decisions and no rates yet, and "$0.00 saved" would be a lie about
 * a number that simply has not arrived.
 *
 * Whichever figure lands here is also the one `tier` describes — a card that
 * colored the dollars and not the tokens would render an overhead as a win
 * the moment pricing was still pending. Tokens kept out are not a verdict on
 * the bill, so only tokens added to context carry one.
 */
function describeHeadline(
  summary: TokenMiserSavingsSummary,
  observedCostMicros: number | undefined,
): TokenMiserHeadline {
  const savingsMicros =
    summary.decisionCount > 0 ? summary.terms?.savingsMicros : undefined;
  if (savingsMicros !== undefined) {
    const { tier } = classifyTokenMiserSavings({
      ...(observedCostMicros === undefined ? {} : { observedCostMicros }),
      savingsMicros,
    });
    return savingsMicros >= 0
      ? {
          tier,
          text: `${formatTokenUsageMicrosAsUsd(savingsMicros)} saved`,
        }
      : {
          tier,
          text: `${formatTokenUsageMicrosAsUsd(
            Math.abs(savingsMicros),
          )} net overhead`,
        };
  }
  const avoided =
    summary.decisionCount > 0 ? summary.avoidedParentTokens : undefined;
  if (avoided !== undefined) {
    // Summaries that ran longer than the payloads they replaced put more in
    // the parent's context than passing the output through would have.
    return avoided >= 0
      ? { text: `${formatCompactCount(avoided)} kept out` }
      : {
          tier: "over",
          text: `${formatCompactCount(Math.abs(avoided))} added to context`,
        };
  }
  if (summary.decisionCount > 0) {
    return { text: `${summary.decisionCount.toLocaleString()} gated` };
  }
  const callCount = summary.codeModeCallCount ?? 0;
  return {
    text: `${callCount.toLocaleString()} Code Mode call${
      callCount === 1 ? "" : "s"
    }`,
  };
}

function describeCaption(params: {
  decisionCount: number;
  observedCostMicros?: number;
  savingsMicros?: number;
}): string {
  if (params.decisionCount === 0) return "No reducer decision was recorded.";
  if (params.savingsMicros === undefined) {
    return TOKEN_MISER_PENDING_PRICING_CAPTION;
  }
  const framing = params.savingsMicros >= 0
    ? "Estimated same-trajectory savings"
    : "Estimated same-trajectory overhead";
  if (!params.observedCostMicros) return framing;
  // The comparison only exists while the unfiltered trajectory costs
  // something. An overhead larger than the bill drives it to zero or below,
  // where "$0.00 unfiltered" would read as a measurement rather than as one.
  const unfilteredCostMicros = params.observedCostMicros + params.savingsMicros;
  if (unfilteredCostMicros <= 0) return framing;
  return `${framing} · ${formatTokenUsageMicrosAsUsd(
    unfilteredCostMicros,
  )} unfiltered`;
}
