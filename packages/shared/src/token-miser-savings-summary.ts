import type { TokenMiserSubAgentAccounting } from "./contracts/navigation";
import type {
  ThreadTokenMiserAccounting,
} from "./contracts/normalized-app-server";

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
  /**
   * Code Mode calls the gate observed. A thread can run Code Mode and reach no
   * reducer decision at all, which is still a Token Miser story worth telling.
   */
  codeModeCallCount?: number;
  /** Decisions Luna evaluated, as opposed to deterministic policy. */
  helperDecisionCount?: number;
  /** Decisions that deliberately returned the ordinary original result. */
  passThroughCount?: number;
  /** Decisions that replaced the payload with a summary. */
  summarizedCount?: number;
  /**
   * Parent-context tokens the gate kept out of the first pass. The same figure
   * the Explorer's lens tab reports as kept out "once" — replays are a second
   * figure there and are deliberately not folded in here.
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
 * The same comparison in two widths: `short` for a rail headline, `sentence`
 * for the popup's figure line. Both views need the same percentage, and a rail
 * that re-cut the sentence with string surgery would silently print the whole
 * sentence the moment the wording changed.
 */
export type TokenMiserSameTrajectoryChange = {
  short: string;
  sentence: string;
  /**
   * The words after `short` in `sentence`, for a view that styles the
   * percentage on its own — the popup sets it as a pill — without cutting
   * the sentence apart itself.
   */
  tail: string;
};

/**
 * How well the gate did for the bill, by degrees.
 *
 * Every surface that reports a Token Miser result colors it from this one
 * scale, so a win reads as a win wherever the operator meets it. The rail
 * card used to leave a saving in body ink and color only an overhead, while
 * the popup painted the brand accent for either sign: a 21.5% saving looked
 * like nothing in one place and like a loss in the other.
 */
export type TokenMiserVerdictTier =
  | "over"
  | "even"
  | "good"
  | "great"
  | "exceptional";

export type TokenMiserVerdict = {
  tier: TokenMiserVerdictTier;
  /**
   * Saving over the estimated unfiltered cost, in percent, signed so a saving
   * is positive. Rounded to the one decimal the views print, so a figure that
   * reads "10.0% less" is always classified as ten. Absent without a priced
   * bill to divide by.
   */
  percent?: number;
};

/** Within this many percent either way, the gate broke even. */
export const TOKEN_MISER_EVEN_BAND_PERCENT = 5;
/** A saving of at least this much is great, and gets the pill. */
export const TOKEN_MISER_GREAT_PERCENT = 10;
/** A saving of at least this much is exceptional, and the card itself says so. */
export const TOKEN_MISER_EXCEPTIONAL_PERCENT = 30;

/**
 * The avoided, gate, and revealed shares of term 1, for the bar under a
 * savings figure. Absent unless the gate saved something: with an overhead
 * the parts sum past the whole, and a bar overflowing its own track reads as
 * a rendering fault.
 */
export type TokenMiserSavingsSplit = {
  avoided: number;
  gate: number;
  revealed: number;
  /**
   * The caption's whole percents. The last term absorbs the rounding instead
   * of being rounded itself: three shares of one whole, each rounded on its
   * own, read as "51% · 3% · 47%" often enough to invite the reader to notice
   * that the decomposition under the bar does not close.
   */
  rounded: { avoided: number; gate: number; revealed: number };
};

/**
 * Shown wherever a thread has gate decisions and no rates yet. One string so
 * the rail and the window make the same promise about when dollars arrive.
 */
export const TOKEN_MISER_PENDING_PRICING_CAPTION =
  "Dollar terms appear once the gate's usage line is priced.";

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
  const codeModeCallCount = params.accounting?.codeMode?.callCount;
  if (decisionCount === 0 && !codeModeCallCount) return undefined;

  const passThroughCount =
    params.accounting?.passThroughCount
    ?? countGates(priced, "disposition", "passed_through");
  // On the thread-accounting path every decision is one or the other, so the
  // complement is exact. Off it, only the gates that actually recorded a
  // disposition can be counted — subtracting a priced-only count from a count
  // of every decision would report unpriced gates as summarized.
  const summarizedCount =
    params.accounting?.passThroughCount === undefined
      ? countGates(priced, "disposition", "summarized")
      : Math.max(0, decisionCount - params.accounting.passThroughCount);
  const helperDecisionCount =
    params.accounting?.helperDecisionCount
    ?? countGates(priced, "decisionSource", "helper");
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
    ...(codeModeCallCount ? { codeModeCallCount } : {}),
    ...(helperDecisionCount === undefined ? {} : { helperDecisionCount }),
    ...(passThroughCount === undefined ? {} : { passThroughCount }),
    ...(summarizedCount === undefined ? {} : { summarizedCount }),
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
): TokenMiserSameTrajectoryChange | undefined {
  const percent = sameTrajectoryPercent(observedCostMicros, savingsMicros);
  if (percent === undefined) return undefined;
  const [short, tail] = savingsMicros === 0
    ? [`${percent.toFixed(1)}% change`, "from estimated unfiltered cost"]
    : [
        `${percent.toFixed(1)}% ${savingsMicros > 0 ? "less" : "more"}`,
        "than estimated unfiltered cost",
      ];
  return { short, sentence: `${short} ${tail}`, tail };
}

/**
 * Place a saving on the verdict scale.
 *
 * The percentage is the one `describeSameTrajectoryCostChange` prints, so a
 * color can never disagree with the number beside it. Without a priced bill
 * there is no percentage, and the sign is all there is to go on: a saving is
 * good, an overhead is over, and nothing at all is even.
 */
export function classifyTokenMiserSavings(params: {
  observedCostMicros?: number;
  savingsMicros: number;
}): TokenMiserVerdict {
  const magnitude = sameTrajectoryPercent(
    params.observedCostMicros ?? 0,
    params.savingsMicros,
  );
  if (magnitude === undefined) {
    return {
      tier: params.savingsMicros > 0
        ? "good"
        : params.savingsMicros < 0
          ? "over"
          : "even",
    };
  }
  const rounded = Number(magnitude.toFixed(1));
  // An overhead that rounds to 0.0% is zero, not negative zero.
  const percent =
    params.savingsMicros < 0 && rounded > 0 ? -rounded : rounded;
  return { tier: tierForPercent(percent), percent };
}

function tierForPercent(percent: number): TokenMiserVerdictTier {
  if (percent >= TOKEN_MISER_EXCEPTIONAL_PERCENT) return "exceptional";
  if (percent >= TOKEN_MISER_GREAT_PERCENT) return "great";
  if (percent >= TOKEN_MISER_EVEN_BAND_PERCENT) return "good";
  if (percent > -TOKEN_MISER_EVEN_BAND_PERCENT) return "even";
  return "over";
}

/**
 * Unsigned: the caller already knows the direction from the saving's sign,
 * and the printed figure never carries one.
 */
function sameTrajectoryPercent(
  observedCostMicros: number,
  savingsMicros: number,
): number | undefined {
  if (observedCostMicros <= 0) return undefined;
  const unfilteredCostMicros = observedCostMicros + savingsMicros;
  if (unfilteredCostMicros <= 0) return undefined;
  return Math.abs(savingsMicros) / unfilteredCostMicros * 100;
}

/** Shared by the popup's bar and the rail card's miniature of it. */
export function buildTokenMiserSavingsSplit(
  terms: TokenMiserSavingsTerms,
): TokenMiserSavingsSplit | undefined {
  const whole = terms.withoutGateCostMicros;
  if (whole <= 0 || terms.savingsMicros <= 0) return undefined;
  const avoided = terms.savingsMicros / whole * 100;
  const gate = terms.gateCostMicros / whole * 100;
  const roundedAvoided = Math.round(avoided);
  const roundedGate = Math.round(gate);
  return {
    avoided,
    gate,
    revealed: terms.revealedCostMicros / whole * 100,
    rounded: {
      avoided: roundedAvoided,
      gate: roundedGate,
      revealed: Math.max(0, 100 - roundedAvoided - roundedGate),
    },
  };
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

/**
 * Tokens the gate kept out of the parent's first pass, replays excluded.
 *
 * The Explorer reports the replay total as its own figure beside this one, so
 * folding them together here would make the rail's number look like the
 * window's while quoting a different quantity.
 */
function readAvoidedParentTokens(
  accounting: ThreadTokenMiserAccounting | undefined,
  priced: readonly TokenMiserSubAgentAccounting[],
): number | undefined {
  if (accounting) return accounting.estimatedParentTokensSaved;
  if (priced.length === 0) return undefined;
  return priced.reduce(
    (total, gate) =>
      total + gate.baselineParentTokens - gate.revealedParentTokens,
    0,
  );
}

/**
 * Count one value of an optional per-gate field across the priced gates.
 *
 * Two ways to report a fact nobody recorded, both avoided here: a thread whose
 * gates have not priced yet has no gates to count, and older gates carry no
 * `disposition` or `decisionSource` at all. Either way the honest answer is
 * that the mix is unknown — "0 passed through" reads as a fact. Absent beats
 * wrong here.
 */
function countGates<K extends "decisionSource" | "disposition">(
  priced: readonly TokenMiserSubAgentAccounting[],
  field: K,
  value: NonNullable<TokenMiserSubAgentAccounting[K]>,
): number | undefined {
  if (!priced.some((gate) => gate[field] !== undefined)) return undefined;
  return priced.filter((gate) => gate[field] === value).length;
}
