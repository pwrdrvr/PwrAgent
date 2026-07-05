/**
 * Exponential-backoff coalescing schedule for messaging streaming edits.
 *
 * When streaming is enabled for a binding, a single bridged assistant message
 * is progressively edited as agent deltas arrive. Every edit counts as a
 * provider message *send*, so emitting one per delta blows through the platform
 * rate budget (Telegram ≈20 msgs/min in groups, ≈60 in DMs) in seconds.
 *
 * The controller debounces per in-flight message with a stored "next allowed
 * release time" timestamp rather than a proliferation of `setTimeout` timers.
 * On each incoming delta, if the stored timestamp has not passed, the delta is
 * coalesced (buffered into the message text) instead of sent. When it passes,
 * the accumulated block is released as one edit and the next release is
 * scheduled further out via {@link coalesceBackoffMs}.
 *
 * The schedule for a single message: the first coalesced block releases
 * ~{@link COALESCE_INITIAL_MS} after the first receipt, then each subsequent
 * release waits twice as long (1s → 2s → 4s → 8s) capped at
 * {@link COALESCE_MAX_MS}. Callers pass the number of releases already made
 * (`releaseCount`), so `0` yields the initial delay and `n ≥ 1` yields the
 * n-th backoff step. The final turn message flushes immediately, bypassing
 * this schedule.
 */

/** Initial coalescing window after the first receipt (~250–500ms). */
export const COALESCE_INITIAL_MS = 400;

/** Base delay for the first backed-off release after the initial block. */
export const COALESCE_BASE_MS = 1_000;

/** Upper bound on the gap between edits for a single in-flight message. */
export const COALESCE_MAX_MS = 16_000;

/**
 * Milliseconds to wait before the next release given how many releases have
 * already happened for this message.
 *
 * - `releaseCount <= 0` → {@link COALESCE_INITIAL_MS} (first coalesced block).
 * - `releaseCount === 1` → {@link COALESCE_BASE_MS} (1s).
 * - `releaseCount === n` → `COALESCE_BASE_MS * 2^(n-1)`, capped at
 *   {@link COALESCE_MAX_MS}.
 */
export function coalesceBackoffMs(releaseCount: number): number {
  if (releaseCount <= 0) {
    return COALESCE_INITIAL_MS;
  }
  const scaled = COALESCE_BASE_MS * 2 ** (releaseCount - 1);
  return Math.min(scaled, COALESCE_MAX_MS);
}
