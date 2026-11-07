import type { ThreadMaintenanceScanProgress } from "@pwragent/shared";

/** A scan reports every item it starts and finishes; a window needs no more
 * than one update per this many milliseconds. */
export const SCAN_PROGRESS_INTERVAL_MS = 250;

export type ScanProgressTarget = {
  send: (channel: string, progress: ThreadMaintenanceScanProgress) => void;
  isDestroyed: () => boolean;
};

/**
 * Sends a scan's progress to the one window that asked for it: the first
 * update at once, then at most one per interval, always ending on the newest.
 * Nothing is sent once the scan settles, so a late timer cannot repaint a
 * finished scan. Kept in memory only.
 */
export function createScanProgressSender(
  target: ScanProgressTarget,
  channel: string,
  progressId: string,
  now: () => number = Date.now,
) {
  let latest: ThreadMaintenanceScanProgress | undefined;
  let lastSent = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const send = () => {
    timer = undefined;
    if (closed || !latest || target.isDestroyed()) return;
    lastSent = now();
    target.send(channel, latest);
  };
  return {
    report: (progress: Omit<ThreadMaintenanceScanProgress, "progressId">) => {
      if (closed) return;
      latest = { ...progress, progressId };
      if (timer) return;
      const wait = SCAN_PROGRESS_INTERVAL_MS - (now() - lastSent);
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
