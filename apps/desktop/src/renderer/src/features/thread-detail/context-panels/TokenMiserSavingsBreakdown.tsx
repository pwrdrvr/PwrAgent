import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { formatTokenUsageMicrosAsUsd } from "@pwragent/shared";

/**
 * One gate's saving, laid out as the operator reasons about it.
 *
 * The arithmetic is (avoided − revealed) per replay, times the replays, minus
 * the summarizer once — with the refinement that the first occurrence is
 * priced uncached and the later ones cached. Presenting it as three separate
 * totals ("without gate", "gate model", "revealed") read as if the whole
 * without-gate figure were being claimed; this reads the equation left to
 * right instead.
 *
 * Not modeled: a retrieval costs the parent one extra round trip — the whole
 * context replayed once more to make the call. Retrievals have been zero in
 * practice, so it has not mattered yet, but it is a real cost of the design.
 */
export function TokenMiserSavingsBreakdown(props: {
  accounting: NonNullable<ThreadSubAgentSummary["tokenMiserAccounting"]>;
}) {
  const accounting = props.accounting;
  const replays = accounting.cachedReplayCount ?? 0;
  const keptOutTokens = Math.max(
    0,
    accounting.baselineParentTokens - accounting.revealedParentTokens,
  );
  const replayValueMicros =
    accounting.baselineParentCostMicros
    + (accounting.cachedBaselineCostMicros ?? 0)
    - accounting.revealedParentCostMicros
    - (accounting.cachedRevealedCostMicros ?? 0);
  const negative = accounting.savingsMicros < 0;
  return (
    <dl
      aria-label="Token Miser savings"
      className="rail-card__token-miser-savings"
      data-negative={negative ? "true" : "false"}
    >
      <div>
        <dt>Kept out of context</dt>
        <dd>
          <strong>
            {accounting.baselineParentTokens.toLocaleString()} → {" "}
            {accounting.revealedParentTokens.toLocaleString()} tokens
          </strong>
          <span>
            {keptOutTokens.toLocaleString()} fewer per request ·{" "}
            {accounting.originalModel}
          </span>
        </dd>
      </div>
      <div>
        <dt>Across requests</dt>
        <dd>
          <strong>{formatTokenUsageMicrosAsUsd(replayValueMicros)}</strong>
          <span>
            once uncached
            {replays > 0
              ? ` + ${replays.toLocaleString()} cached ${replays === 1 ? "replay" : "replays"}`
              : " · no replays observed"}
          </span>
        </dd>
      </div>
      <div>
        <dt>Summarizer, once</dt>
        <dd>
          <strong>−{formatTokenUsageMicrosAsUsd(accounting.gateCostMicros)}</strong>
          <span>
            {accounting.gateTotalTokens.toLocaleString()} tokens · {accounting.gateModel}
          </span>
        </dd>
      </div>
      <div data-total="true">
        <dt>{negative ? "Net overhead" : "Saved"}</dt>
        <dd>
          <strong>
            {formatTokenUsageMicrosAsUsd(Math.abs(accounting.savingsMicros))}
          </strong>
        </dd>
      </div>
    </dl>
  );
}
