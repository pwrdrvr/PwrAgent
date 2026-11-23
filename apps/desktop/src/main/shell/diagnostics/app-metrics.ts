import { app } from "electron";
import type { ProcessMetric } from "electron";

export type AppCpuEstimate = {
  generation: number;
  cpuMs: number;
};

export type AppMetricsReading = {
  metrics: ProcessMetric[];
  capturedAtMs: number;
  cpuEstimates: ReadonlyMap<number, AppCpuEstimate>;
};

/**
 * Electron resets every process's interval percentage on each app metrics
 * read. Accumulate the shared interval pieces once, so each profiler can
 * measure its own window even when other targets or diagnostics read between
 * its endpoints. Native process counters take precedence when available.
 */
export function createAppMetricsReader(
  read: () => ProcessMetric[],
  now: () => number,
): () => AppMetricsReading {
  let previous: {
    atMs: number;
    estimates: Map<number, AppCpuEstimate & { creationTime: number }>;
  } | undefined;
  let generation = 0;
  return () => {
    const atMs = now();
    const last = previous;
    // A failed native read may have reset the percentages before it threw.
    previous = undefined;
    const metrics = read();
    const elapsedMs = last ? atMs - last.atMs : 0;
    const estimates = new Map<number, AppCpuEstimate & { creationTime: number }>();
    for (const { pid, creationTime, cpu } of metrics) {
      if (Number.isFinite(cpu.cumulativeCPUUsage)) continue;
      const prior = last?.estimates.get(pid);
      const percent = cpu.percentCPUUsage;
      const continuous = prior && prior.creationTime === creationTime && elapsedMs > 0
        && Number.isFinite(percent) && percent >= 0;
      estimates.set(pid, {
        creationTime,
        generation: continuous ? prior.generation : ++generation,
        cpuMs: continuous ? prior.cpuMs + elapsedMs * percent / 100 : 0,
      });
    }
    previous = { atMs, estimates };
    return { metrics, capturedAtMs: atMs, cpuEstimates: estimates };
  };
}

export const readAppMetrics = createAppMetricsReader(
  () => app.getAppMetrics?.() ?? [],
  () => performance.now(),
);
