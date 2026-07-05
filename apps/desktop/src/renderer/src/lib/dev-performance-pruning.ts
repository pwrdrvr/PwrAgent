type PerformanceTimeline = Pick<Performance, "clearMarks" | "clearMeasures"> & {
  getEntriesByType: (type: "mark" | "measure") => ArrayLike<unknown>;
};

type TimerApi = {
  setInterval: (callback: () => void, intervalMs: number) => unknown;
  clearInterval: (intervalId: unknown) => void;
};

export type DevPerformancePruningHandle = {
  prune: () => number;
  stop: () => void;
};

export function installDevPerformancePruning(
  options: {
    intervalMs?: number;
    maxMarks?: number;
    maxMeasures?: number;
    performance?: PerformanceTimeline;
    timerApi?: TimerApi;
  } = {},
): DevPerformancePruningHandle {
  const performanceApi = options.performance ?? window.performance;
  const timerApi: TimerApi = options.timerApi ?? {
    setInterval: (callback, intervalMs) =>
      window.setInterval(callback, intervalMs),
    clearInterval: (intervalId) => {
      window.clearInterval(intervalId as number);
    },
  };
  const maxMarks = options.maxMarks ?? 10_000;
  const maxMeasures = options.maxMeasures ?? 10_000;

  const prune = () => {
    const measureCount = performanceApi.getEntriesByType("measure").length;
    const markCount = performanceApi.getEntriesByType("mark").length;

    if (measureCount <= maxMeasures && markCount <= maxMarks) {
      return 0;
    }

    performanceApi.clearMeasures();
    performanceApi.clearMarks();
    return measureCount + markCount;
  };

  const intervalId = timerApi.setInterval(prune, options.intervalMs ?? 10_000);

  return {
    prune,
    stop: () => {
      timerApi.clearInterval(intervalId);
    },
  };
}
