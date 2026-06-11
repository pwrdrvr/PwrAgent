import { describe, expect, it, vi } from "vitest";
import { installDevPerformancePruning } from "../dev-performance-pruning";

function makePerformanceTimeline(params: {
  markCount: number;
  measureCount: number;
}) {
  return {
    clearMarks: vi.fn(),
    clearMeasures: vi.fn(),
    getEntriesByType: vi.fn((type: string) => {
      if (type === "measure") {
        return Array.from({ length: params.measureCount });
      }
      if (type === "mark") {
        return Array.from({ length: params.markCount });
      }
      return [];
    })
  };
}

describe("installDevPerformancePruning", () => {
  it("leaves small user timing buffers alone", () => {
    const performance = makePerformanceTimeline({
      markCount: 2,
      measureCount: 3
    });
    const intervalId = 42;
    const timerApi = {
      setInterval: vi.fn(() => intervalId),
      clearInterval: vi.fn()
    };

    const handle = installDevPerformancePruning({
      maxMarks: 10,
      maxMeasures: 10,
      performance,
      timerApi
    });

    expect(handle.prune()).toBe(0);
    expect(performance.clearMeasures).not.toHaveBeenCalled();
    expect(performance.clearMarks).not.toHaveBeenCalled();

    handle.stop();
    expect(timerApi.clearInterval).toHaveBeenCalledWith(intervalId);
  });

  it("clears marks and measures once either buffer exceeds the cap", () => {
    const performance = makePerformanceTimeline({
      markCount: 11,
      measureCount: 3
    });

    const handle = installDevPerformancePruning({
      maxMarks: 10,
      maxMeasures: 10,
      performance,
      timerApi: {
        setInterval: vi.fn(() => 7),
        clearInterval: vi.fn()
      }
    });

    expect(handle.prune()).toBe(14);
    expect(performance.clearMeasures).toHaveBeenCalledTimes(1);
    expect(performance.clearMarks).toHaveBeenCalledTimes(1);
  });
});
