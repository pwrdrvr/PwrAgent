import type { TokenMiserSavingsTerms } from "@pwragent/shared";

/** Display-only allocation for the two summary cards; never feed this into accounting. */
export function roundPricingSummary(
  costMicros: number,
  terms: TokenMiserSavingsTerms,
  modelCostsMicros: number[],
) {
  // Keep mill precision when the entire comparison is smaller than ten cents.
  const unit = Math.max(costMicros, terms.withoutGateCostMicros,
    terms.gateCostMicros, terms.revealedCostMicros, Math.abs(terms.savingsMicros)) < 100_000
    ? 1_000 : 10_000;
  const cost = Math.round(costMicros / unit);
  const savings = (Math.sign(terms.savingsMicros) * Math.round(Math.abs(terms.savingsMicros) / unit)) || 0;
  // Treat the subtraction as signed components. Largest remainders receive
  // the remaining units, with input order breaking ties deterministically.
  const [without, gate, revealed] = allocateRoundedUnits(
    [terms.withoutGateCostMicros, -terms.gateCostMicros, -terms.revealedCostMicros],
    savings,
    unit,
  );
  return {
    costMicros: cost * unit,
    savingsMicros: savings * unit,
    unfilteredCostMicros: (cost + savings) * unit,
    withoutGateCostMicros: without! * unit,
    gateCostMicros: Math.abs(gate!) * unit,
    revealedCostMicros: Math.abs(revealed!) * unit,
    // A partial model ledger cannot be reconciled by redistributing pennies.
    modelCostsMicros: modelCostsMicros.reduce((sum, value) => sum + value, 0) === costMicros
      ? allocateRoundedUnits(modelCostsMicros, cost, unit).map((value) => value * unit)
      : undefined,
  };
}

export type RoundedPricingSummary = ReturnType<typeof roundPricingSummary>;

function allocateRoundedUnits(values: number[], target: number, unit: number): number[] {
  const rounded = values.map((value) => Math.floor(value / unit));
  const remaining = target - rounded.reduce((sum, value) => sum + value, 0);
  const order = values.map((value, index) => ({ index, remainder: value - rounded[index]! * unit }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const { index } of order.slice(0, remaining)) rounded[index]! += 1;
  return rounded;
}

/** Values already allocated in integer units must not pass through the upward rounder again. */
export function formatRoundedSummaryMoney(micros: number): string {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
    minimumFractionDigits: Math.abs(micros) < 100_000 ? 3 : 2,
    maximumFractionDigits: 3,
  }).format(micros / 1_000_000);
}

export function exactSummaryMoneyTitle(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)} before display rounding`;
}
