// The byte meter every download card prints: the managed runtimes (Codex,
// Grok, Git, Antigravity) and PwrAgent's own update. One function, so the
// two cards cannot round, separate or estimate differently.

import { formatByteCount } from "./format-bytes";

export type DownloadMeterInput = {
  /** Bytes written so far. */
  receivedBytes?: number;
  /** Size the source advertises, when it advertises one. */
  totalBytes?: number;
  bytesPerSecond?: number;
};

/**
 * The widest meter `formatDownloadMeter` prints, for a card that reserves
 * its line before the first byte arrives.
 */
export const DOWNLOAD_METER_RESERVE = "000.0 MB of 000.0 MB · 00.0 MB/s · about 00 min left";

/**
 * "41.2 MB of 96.0 MB · 8.3 MB/s · about 7 s left", trimmed to what is known.
 * `eta: false` drops the estimate for a line too narrow to hold it.
 */
export function formatDownloadMeter(
  input: DownloadMeterInput,
  options: { eta?: boolean } = {},
): string | undefined {
  const received = isCount(input.receivedBytes) ? input.receivedBytes : undefined;
  const total = isPositive(input.totalBytes) ? input.totalBytes : undefined;
  const rate = isPositive(input.bytesPerSecond) ? input.bytesPerSecond : undefined;
  const parts: string[] = [];
  if (received !== undefined) {
    parts.push(
      total !== undefined
        ? `${formatByteCount(received)} of ${formatByteCount(total)}`
        : formatByteCount(received),
    );
  }
  if (rate !== undefined) {
    parts.push(`${formatByteCount(Math.round(rate))}/s`);
    if (options.eta !== false && received !== undefined && total !== undefined && total > received) {
      parts.push(`about ${formatEta((total - received) / rate)} left`);
    }
  }
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function formatEta(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  return `${Math.round(seconds / 60)} min`;
}

function isCount(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

function isPositive(value: number | undefined): value is number {
  return isCount(value) && value > 0;
}
