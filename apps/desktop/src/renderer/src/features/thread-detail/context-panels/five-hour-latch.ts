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
 * A provider's cap with no window (Codex's Individual limit) latches the same
 * way through `capLatchSample`.
 *
 * The state lives here, in memory, not in the peek, which unmounts on every
 * hover-out. A restart starts every scope hidden.
 */

/** At or above this used or projected percent, the 5h row shows. */
export const FIVE_HOUR_SHOW_PERCENT = 80;
/** Below this projected percent, a shown 5h row hides. */
export const FIVE_HOUR_HIDE_PERCENT = 60;
/**
 * A reset that moves this much or less is the provider restating the same
 * deadline, not a new window: Claude's stream rounds `resetAt` up to the
 * next hour, so a snapshot and a stream update can differ by up to an hour
 * (the usage series allows 2 h for the same reason). A 5h window's next
 * reset is 5 hours on.
 */
export const FIVE_HOUR_SAME_WINDOW_MS = 2 * 60 * 60_000;

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

/**
 * A cap's reading. A cap has no pace, so where it lands is where it is: it
 * shows at 80% used and hides only below 60% used.
 */
export function capLatchSample(usedPercent: number, resetAt?: number): FiveHourSample {
  return { usedPercent, projectedPercent: usedPercent, ...(resetAt === undefined ? {} : { resetAt }) };
}

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

/**
 * A 5h window, as the latch keys it: by the limit itself, never by the
 * scope's display name, which changes ("All models") when a provider gains
 * a second scope.
 */
export function fiveHourLatchKey(
  provider: string,
  limit: { limitId?: string; windowKey?: string; name: string },
): string {
  return JSON.stringify([provider, limit.limitId ?? "", limit.windowKey ?? "", limit.name]);
}
