import { app } from "electron";
import type { ProcessMetric } from "electron";

export type AppMetricsReading = {
  metrics: ProcessMetric[];
  capturedAtMs: number;
  previousReadMs?: number;
};

let lastReadMs: number | undefined;

/** Electron resets its interval percentage for every process on each call. */
export function readAppMetrics(): AppMetricsReading {
  const capturedAtMs = performance.now();
  const previousReadMs = lastReadMs;
  lastReadMs = capturedAtMs;
  return { metrics: app.getAppMetrics(), capturedAtMs, previousReadMs };
}
