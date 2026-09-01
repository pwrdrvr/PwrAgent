import type {
  ThreadTokenMiserAccounting,
  TokenMiserSubAgentAccounting,
} from "@pwragent/shared";

/**
 * One thread's Token Miser result, in the same three terms the Explorer's
 * savings lens and the per-gate breakdown already use.
 *
 * The Pricing rail and the Explorer window answer the same question from two
 * different reads of the same thread, so the arithmetic lives here rather than
 * in either view. Two copies of "1 − 2 − 3" is two chances to disagree, and a
 * rail that quotes a different number than the window it links to is worse
 * than a rail that says nothing.
 */
export type TokenMiserSavingsSummary = {
  /** Reducer decisions, priced or not. */
  decisionCount: number;
  /** Decisions whose dollar terms are complete. */
  pricedDecisionCount: number;
  /** Decisions Luna evaluated, as opposed to deterministic policy. */
  helperDecisionCount?: number;
  /** Decisions that deliberately returned the ordinary original result. */
  passThroughCount?: number;
  /** Decisions that replaced the payload with a summary. */
  summarizedCount?: number;
  /**
   * Parent-context tokens the gate kept out, counted once plus every replay.
   * The same figure the Explorer's lens tab reports as "avoided".
   */
  avoidedParentTokens?: number;
  /**
   * The dollar terms, absent until at least one gate is priced. A gate is
   * priced only once its own usage line lands and the parent turn has a known
   * model and rate, so a live turn can have decisions and no terms yet.
   */
  terms?: TokenMiserSavingsTerms;
};

export type TokenMiserSavingsTerms = {
  /** 1 — the gated payloads at parent rates, uncached once plus replays. */
  withoutGateCostMicros: number;
  /** 2 — what the helper actually charged. */
  gateCostMicros: number;
  /** 3 — summaries and retrievals the parent did receive, and their replays. */
  revealedCostMicros: number;
  /** 1 − 2 − 3. Negative when the gate cost more than it saved. */
  savingsMicros: number;
};

/**
 * Build the thread-level summary from whichever source this view has.
 *
 * `accounting` is thread-level and authoritative: the Explorer reads it
 * straight from the main process and the numbers below are the ones that
 * window shows. The Pricing rail only receives it when the thread
 * tool-accounting experiment is on, so the per-gate records it always has are
 * the fallback — the same records the per-turn folds already sum.
 */
export function buildTokenMiserSavingsSummary(params: {
  accounting?: ThreadTokenMiserAccounting;
  gateAccountings: readonly (TokenMiserSubAgentAccounting | undefined)[];
}): TokenMiserSavingsSummary | undefined {
  const savings = params.accounting?.savings;
  const priced = params.gateAccountings.filter(
    (gate): gate is TokenMiserSubAgentAccounting => gate !== undefined,
  );
  const decisionCount =
    params.accounting?.interceptionCount ?? params.gateAccountings.length;
  if (decisionCount === 0) return undefined;

  const passThroughCount =
    params.accounting?.passThroughCount
    ?? countGates(priced, (gate) => gate.disposition === "passed_through");
  const helperDecisionCount =
    params.accounting?.helperDecisionCount
    ?? countGates(priced, (gate) => gate.decisionSource !== "policy");
  const avoidedParentTokens = readAvoidedParentTokens(params.accounting, priced);
  const terms = savings
    ? {
        withoutGateCostMicros: savings.withoutGateCostMicros,
        gateCostMicros: savings.gateCostMicros,
        revealedCostMicros: savings.revealedCostMicros,
        savingsMicros: savings.savingsMicros,
      }
    : priced.length > 0
      ? sumGateTerms(priced)
      : undefined;

  return {
    decisionCount,
    pricedDecisionCount: savings?.pricedGateCount ?? priced.length,
    ...(helperDecisionCount === undefined ? {} : { helperDecisionCount }),
    ...(passThroughCount === undefined
      ? {}
      : {
          passThroughCount,
          summarizedCount: Math.max(0, decisionCount - passThroughCount),
        }),
    ...(avoidedParentTokens === undefined ? {} : { avoidedParentTokens }),
    ...(terms === undefined ? {} : { terms }),
  };
}

/**
 * The popup's headline comparison, shared so the rail cannot round it
 * differently: what the same trajectory would have cost with nothing filtered,
 * and how far the observed bill came in under it.
 */
export function describeSameTrajectoryCostChange(
  observedCostMicros: number,
  savingsMicros: number,
): string | undefined {
  if (observedCostMicros <= 0) return undefined;
  const unfilteredCostMicros = observedCostMicros + savingsMicros;
  if (unfilteredCostMicros <= 0) return undefined;
  const percent = Math.abs(savingsMicros) / unfilteredCostMicros * 100;
  if (savingsMicros === 0) {
    return `${percent.toFixed(1)}% change from estimated unfiltered cost`;
  }
  return `${percent.toFixed(1)}% ${savingsMicros > 0 ? "less" : "more"} `
    + "than estimated unfiltered cost";
}

/**
 * Sum only the gates that priced. An unpriced gate contributes tokens to the
 * counts above and nothing here, which is why `pricedDecisionCount` is
 * reported separately — a partial total must not read as a complete one.
 */
function sumGateTerms(
  gates: readonly TokenMiserSubAgentAccounting[],
): TokenMiserSavingsTerms {
  return gates.reduce<TokenMiserSavingsTerms>(
    (terms, gate) => ({
      withoutGateCostMicros:
        terms.withoutGateCostMicros
        + gate.baselineParentCostMicros
        + (gate.cachedBaselineCostMicros ?? 0),
      gateCostMicros: terms.gateCostMicros + gate.gateCostMicros,
      revealedCostMicros:
        terms.revealedCostMicros
        + gate.revealedParentCostMicros
        + (gate.cachedRevealedCostMicros ?? 0),
      savingsMicros: terms.savingsMicros + gate.savingsMicros,
    }),
    {
      withoutGateCostMicros: 0,
      gateCostMicros: 0,
      revealedCostMicros: 0,
      savingsMicros: 0,
    },
  );
}

function readAvoidedParentTokens(
  accounting: ThreadTokenMiserAccounting | undefined,
  priced: readonly TokenMiserSubAgentAccounting[],
): number | undefined {
  if (accounting) {
    return (
      accounting.estimatedParentTokensSaved
      + (accounting.estimatedCachedReplayTokensSaved ?? 0)
    );
  }
  if (priced.length === 0) return undefined;
  return priced.reduce(
    (total, gate) =>
      total
      + gate.baselineParentTokens
      + (gate.cachedBaselineTokens ?? 0)
      - gate.revealedParentTokens
      - (gate.cachedRevealedTokens ?? 0),
    0,
  );
}

/**
 * Counting a disposition across only the priced gates would report "0 passed
 * through" on a thread whose gates have not priced yet, which reads as a fact
 * rather than as missing data. Absent beats wrong here.
 */
function countGates(
  priced: readonly TokenMiserSubAgentAccounting[],
  predicate: (gate: TokenMiserSubAgentAccounting) => boolean,
): number | undefined {
  if (priced.length === 0) return undefined;
  return priced.filter(predicate).length;
}
