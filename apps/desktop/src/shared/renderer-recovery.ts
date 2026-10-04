// Lifetime budgets, deliberately not replenished by a successful render/load.
// A persistent or periodically recurring fault must eventually stop retrying.
export const MAX_AUTOMATIC_RENDERER_RECOVERIES = 2;
export const RENDERER_RECOVERY_DELAY_MS = 1_000;

