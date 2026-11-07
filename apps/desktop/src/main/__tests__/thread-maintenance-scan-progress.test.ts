import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { ThreadMaintenanceScanProgress } from "@pwragent/shared";
import { createScanProgressSender, SCAN_PROGRESS_INTERVAL_MS } from "../thread-maintenance-scan-progress";

afterEach(() => {
  vi.useRealTimers();
});

const CHANNEL = "thread-maintenance:scan-progress";

function progress(processed: number): Omit<ThreadMaintenanceScanProgress, "progressId"> {
  return { steps: ["checkouts"], step: "checkouts", stage: "checking", processed, total: 1_000, inFlight: [] };
}

function target() {
  const sent: { at: number; progress: ThreadMaintenanceScanProgress }[] = [];
  return {
    sent,
    target: {
      send: vi.fn((_channel: string, value: ThreadMaintenanceScanProgress) => { sent.push({ at: Date.now(), progress: value }); }),
      isDestroyed: () => false,
    },
  };
}

describe("createScanProgressSender", () => {
  // Model: whatever the timing of reports, the window gets the first report
  // at once, never two sends closer than the interval, never a stale value
  // as the last one, and nothing after the scan settles.
  it("sends the newest progress at most once per interval and nothing after close", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 0, max: 250 }), { minLength: 1, maxLength: 60 }), (gaps) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const { sent, target: window } = target();
      const sender = createScanProgressSender(window, CHANNEL, "scan-1");
      gaps.forEach((gap, index) => {
        vi.advanceTimersByTime(gap);
        sender.report(progress(index + 1));
        if (index === 0) expect(sent).toHaveLength(1);
      });
      vi.advanceTimersByTime(SCAN_PROGRESS_INTERVAL_MS);
      expect(sent.at(-1)!.progress.processed).toBe(gaps.length);
      expect(sent.every((item) => item.progress.progressId === "scan-1")).toBe(true);
      for (let index = 1; index < sent.length; index++) {
        expect(sent[index]!.at - sent[index - 1]!.at).toBeGreaterThanOrEqual(SCAN_PROGRESS_INTERVAL_MS);
        expect(sent[index]!.progress.processed).toBeGreaterThan(sent[index - 1]!.progress.processed);
      }
      const count = sent.length;
      sender.report(progress(gaps.length + 1));
      sender.close();
      sender.report(progress(gaps.length + 2));
      vi.advanceTimersByTime(10 * SCAN_PROGRESS_INTERVAL_MS);
      expect(sent.length - count).toBeLessThanOrEqual(1);
      expect(sent.every((item) => item.progress.processed <= gaps.length + 1)).toBe(true);
      vi.useRealTimers();
    }), { numRuns: 200 });
  });

  it("drops a pending update when the scan settles first", () => {
    vi.useFakeTimers();
    const { sent, target: window } = target();
    const sender = createScanProgressSender(window, CHANNEL, "scan-1");
    sender.report(progress(1));
    sender.report(progress(2));
    sender.close();
    vi.advanceTimersByTime(SCAN_PROGRESS_INTERVAL_MS * 2);
    expect(sent.map((item) => item.progress.processed)).toEqual([1]);
  });

  it("sends nothing to a closed window", () => {
    const send = vi.fn();
    const sender = createScanProgressSender({ send, isDestroyed: () => true }, CHANNEL, "scan-1");
    sender.report(progress(1));
    expect(send).not.toHaveBeenCalled();
  });
});
