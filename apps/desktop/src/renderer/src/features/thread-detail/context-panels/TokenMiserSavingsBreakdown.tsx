import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";

export function TokenMiserSavingsBreakdown(props: {
  accounting: NonNullable<ThreadSubAgentSummary["tokenMiserAccounting"]>;
}) {
  const accounting = props.accounting;
  const savingsLabel = accounting.savingsMicros >= 0 ? "Savings" : "Net overhead";
  return (
    <dl
      aria-label="Token Miser savings"
      className="rail-card__token-miser-savings"
    >
      <div>
        <dt>1 · Without gate</dt>
        <dd>
          <strong>{formatTokenUsageMicrosAsUsd(accounting.baselineParentCostMicros)}</strong>
          <span>
            {accounting.baselineParentTokens.toLocaleString()} uncached ·{" "}
            {accounting.originalModel}
          </span>
        </dd>
      </div>
      <div>
        <dt>2 · Gate model</dt>
        <dd>
          <strong>{formatTokenUsageMicrosAsUsd(accounting.gateCostMicros)}</strong>
          <span>
            {accounting.gateTotalTokens.toLocaleString()} total · {accounting.gateModel}
          </span>
        </dd>
      </div>
      <div>
        <dt>3 · Revealed to parent</dt>
        <dd>
          <strong>{formatTokenUsageMicrosAsUsd(accounting.revealedParentCostMicros)}</strong>
          <span>
            {accounting.revealedParentTokens.toLocaleString()} uncached ·{" "}
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
