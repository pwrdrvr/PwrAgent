import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";

export function TokenMiserSavingsBreakdown(props: {
  accounting: NonNullable<ThreadSubAgentSummary["tokenMiserAccounting"]>;
}) {
  const accounting = props.accounting;
  const passedThrough = accounting.disposition === "passed_through";
  const policyDecision = accounting.decisionSource === "policy";
  const savingsLabel = accounting.savingsMicros >= 0 ? "Savings" : "Net overhead";
  const cachedReplayCount = accounting.cachedReplayCount ?? 0;
  const cachedBaselineTokens = accounting.cachedBaselineTokens ?? 0;
  const cachedBaselineCostMicros = accounting.cachedBaselineCostMicros ?? 0;
  const cachedRevealedTokens = accounting.cachedRevealedTokens ?? 0;
  const cachedRevealedCostMicros = accounting.cachedRevealedCostMicros ?? 0;
  return (
    <dl
      aria-label="Token Miser savings"
      className="rail-card__token-miser-savings"
    >
      <div>
        <dt>{passedThrough ? "1 · Ordinary result" : "1 · Without gate"}</dt>
        <dd>
          <strong>
            {formatTokenUsageMicrosAsUsd(
              accounting.baselineParentCostMicros + cachedBaselineCostMicros,
            )}
          </strong>
          <span>
            {accounting.baselineParentTokens.toLocaleString()} uncached
            {cachedBaselineTokens > 0
              ? ` + ${cachedBaselineTokens.toLocaleString()} cached across ${cachedReplayCount.toLocaleString()} ${cachedReplayCount === 1 ? "replay" : "replays"}`
              : ""}
            {" · "}
            {accounting.originalModel}
          </span>
        </dd>
      </div>
      <div>
        <dt>
          {policyDecision
            ? "2 · Policy evaluation"
            : passedThrough
              ? "2 · Evaluation model"
              : "2 · Gate model"}
        </dt>
        <dd>
          <strong>{formatTokenUsageMicrosAsUsd(accounting.gateCostMicros)}</strong>
          <span>
            {policyDecision
              ? "No helper model invoked"
              : `${accounting.gateTotalTokens.toLocaleString()} total · ${accounting.gateModel}`}
          </span>
        </dd>
      </div>
      <div>
        <dt>{passedThrough ? "3 · Passed to parent" : "3 · Revealed to parent"}</dt>
        <dd>
          <strong>
            {formatTokenUsageMicrosAsUsd(
              accounting.revealedParentCostMicros + cachedRevealedCostMicros,
            )}
          </strong>
          <span>
            {accounting.revealedParentTokens.toLocaleString()} uncached
            {cachedRevealedTokens > 0
              ? ` + ${cachedRevealedTokens.toLocaleString()} cached`
              : ""}
            {" · "}
            {accounting.originalModel}
          </span>
        </dd>
      </div>
      <div data-total="true">
        <dt>{savingsLabel} · 1 − 2 − 3</dt>
        <dd>
          <strong>
            {formatTokenUsageMicrosAsUsd(Math.abs(accounting.savingsMicros))}
          </strong>
        </dd>
      </div>
    </dl>
  );
}
