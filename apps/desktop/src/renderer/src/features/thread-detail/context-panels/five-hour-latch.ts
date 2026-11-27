/**
 * Whether the AI provider gauge's peek shows a scope's 5h row beside its
 * Weekly one. The 5h row appears when the window is at risk, with
 * hysteresis so it does not flicker:
 *
 * - it shows at 80% used, or at 80% projected at the reset;
 * - it hides only once the projection falls under 60%;
 * - between the two, and while the projection is unknown, it keeps its state;
 * - a new window (the reset moved) starts hidden.
 *
 * The state lives here, in memory, not in the peek, which unmounts on every
 * hover-out. A restart starts every scope hidden.
 */

/** At or above this used or projected percent, the 5h row shows. */
export const FIVE_HOUR_SHOW_PERCENT = 80;
/** Below this projected percent, a shown 5h row hides. */
export const FIVE_HOUR_HIDE_PERCENT = 60;
/**
 * A reset that moves less than this is the provider rounding the same
 * deadline (Claude's stream rounds to the hour), not a new window; a 5h
 * window's next reset is hours away.
 */
export const FIVE_HOUR_SAME_WINDOW_MS = 10 * 60_000;

/** One reading of a scope's 5h window. */
export type FiveHourSample = {
  usedPercent?: number;
  /**
   * Where the pace lands at the reset, as the row's pace line reads it.
   * Undefined when unknown: under 30 minutes of the window, or no pace.
   */
  projectedPercent?: number;
  resetAt?: number;
};

export type FiveHourLatch = { shown: boolean; resetAt?: number };

/** A reset this far from the last one starts a new window. */
function isNewWindow(latch: FiveHourLatch, resetAt: number | undefined): boolean {
  // A reading that omits its reset says nothing about the window.
  if (resetAt === undefined || latch.resetAt === undefined) return false;
  return Math.abs(resetAt - latch.resetAt) > FIVE_HOUR_SAME_WINDOW_MS;
}

/** The latch after one sample; the first sample starts hidden. */
export function stepFiveHourLatch(latch: FiveHourLatch | undefined, sample: FiveHourSample): FiveHourLatch {
  const previous = latch && !isNewWindow(latch, sample.resetAt) ? latch : undefined;
  let shown = previous?.shown ?? false;
  const { usedPercent, projectedPercent } = sample;
  if ((usedPercent !== undefined && usedPercent >= FIVE_HOUR_SHOW_PERCENT)
    || (projectedPercent !== undefined && projectedPercent >= FIVE_HOUR_SHOW_PERCENT)) {
    shown = true;
  } else if (projectedPercent !== undefined && projectedPercent < FIVE_HOUR_HIDE_PERCENT) {
    shown = false;
  }
  return { shown, resetAt: sample.resetAt ?? latch?.resetAt };
}

export type FiveHourLatchStore = {
  /** Steps the scope's latch with a reading and returns whether it shows. */
  observe: (key: string, sample: FiveHourSample) => boolean;
  shown: (key: string) => boolean;
  clear: () => void;
};

export function createFiveHourLatchStore(): FiveHourLatchStore {
  const latches = new Map<string, FiveHourLatch>();
  return {
    observe: (key, sample) => {
      const next = stepFiveHourLatch(latches.get(key), sample);
      latches.set(key, next);
      return next.shown;
    },
    shown: (key) => latches.get(key)?.shown ?? false,
    clear: () => latches.clear(),
  };
}

/** The one store for this window, shared by every peek. */
export const fiveHourLatches = createFiveHourLatchStore();

/** A provider's scope, as the latch keys it. */
export function fiveHourLatchKey(provider: string, scope: string | null): string {
  return JSON.stringify([provider, scope ?? ""]);
}
