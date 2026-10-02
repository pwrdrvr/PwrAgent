/**
 * Human-readable duration formatting shared across the renderer.
 *
 * `formatDurationMs` renders a finished duration in the coarse
 * `2h 3m 4s` / `1d 1h` style used on action-run cards and pricing
 * turn-usage cards. `formatRunningDurationMs` is the live variant that
 * floors to whole seconds (so a ticking clock never shows sub-second
 * jitter) and renders `0s` at rest instead of an empty string.
 *
 * Lifted out of `EnvActionRunsView.tsx` so the pricing panel can reuse
 * the exact same duration vocabulary without a feature-to-feature import.
 */
export function formatDurationMs(
  ms?: number,
  options?: { coarseAfterMinute?: boolean },
): string {
  if (!ms || !Number.isFinite(ms)) return "";
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    if (options?.coarseAfterMinute) return `${totalMinutes}m`;
    return seconds ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) {
    return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

export function formatRunningDurationMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const totalSeconds = Math.floor(ms / 1_000);
  if (totalSeconds < 1) return "0s";
  return formatDurationMs(totalSeconds * 1_000);
}

/**
 * A live clock: `45s`, `1m 06s`, `1h 2m 3s`. Seconds are padded under an
 * hour so a ticking label keeps its width. The turn timer ("Working for")
 * and the live voice session timer both read this.
 */
export function formatElapsedMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (totalMinutes > 0) {
    return `${totalMinutes}m ${seconds.toString().padStart(2, "0")}s`;
  }
  return `${seconds}s`;
}
