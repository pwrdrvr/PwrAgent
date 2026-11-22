import type { ProcessMetric } from "electron";
import fc from "fast-check";
import { expect, it } from "vitest";
import { createAppMetricsReader } from "../shell/diagnostics/app-metrics";

function metric(pid: number, percentCPUUsage: number, creationTime = 1): ProcessMetric {
  return {
    pid,
    type: pid === 1 ? "Browser" : "Tab",
    creationTime,
    cpu: { percentCPUUsage, idleWakeupsPerSecond: 0 },
    memory: { workingSetSize: 0, peakWorkingSetSize: 0 },
  };
}

it("shares the entire measured CPU window with consumers that interleave native reads", async () => {
  const read = fc.record({
    caller: fc.constantFrom(1 as const, 2 as const, "rendering-diagnostics" as const),
    elapsedMs: fc.integer({ min: 1, max: 1_000 }),
    mainPercent: fc.integer({ min: 0, max: 400 }),
    rendererPercent: fc.integer({ min: 0, max: 400 }),
  });
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.array(read, { minLength: 10, maxLength: 25 }), async (scheduler, reads) => {
    let now = 0;
    let mainCpuMs = 0;
    let rendererCpuMs = 0;
    let lastReadAt = 0;
    let mainCpuAtLastRead = 0;
    let rendererCpuAtLastRead = 0;
    const readMetrics = createAppMetricsReader(() => {
      const elapsedMs = now - lastReadAt;
      // Model Electron's interval percentages from independent cumulative clocks.
      const mainPercent = elapsedMs ? (mainCpuMs - mainCpuAtLastRead) / elapsedMs * 100 : 0;
      const rendererPercent = elapsedMs ? (rendererCpuMs - rendererCpuAtLastRead) / elapsedMs * 100 : 0;
      lastReadAt = now;
      mainCpuAtLastRead = mainCpuMs;
      rendererCpuAtLastRead = rendererCpuMs;
      return [metric(1, mainPercent), metric(2, rendererPercent)];
    }, () => now);
    const seen = new Map<number, { observedCpuMs: number; expectedCpuMs: number; generation: number }>();
    const pending = reads.map((next) => scheduler.schedule(Promise.resolve()).then(() => {
      now += next.elapsedMs;
      mainCpuMs += next.elapsedMs * next.mainPercent / 100;
      rendererCpuMs += next.elapsedMs * next.rendererPercent / 100;
      const { cpuEstimates } = readMetrics();
      if (next.caller === "rendering-diagnostics") return;
      const observed = cpuEstimates.get(next.caller)!;
      const expectedCpuMs = next.caller === 1 ? mainCpuMs : rendererCpuMs;
      const previous = seen.get(next.caller);
      if (previous) {
        expect(observed.generation).toBe(previous.generation);
        expect(observed.cpuMs - previous.observedCpuMs).toBeCloseTo(expectedCpuMs - previous.expectedCpuMs, 8);
      }
      seen.set(next.caller, { observedCpuMs: observed.cpuMs, expectedCpuMs, generation: observed.generation });
    }));
    await scheduler.waitAll();
    await Promise.all(pending);
  }));
});

it("never joins fallback intervals across a missing metric, a reused PID, or a native-counter switch", () => {
  let atMs = 0;
  let metrics: ProcessMetric[] = [metric(1, 100)];
  const read = createAppMetricsReader(() => metrics, () => atMs += 1_000);
  const initial = read().cpuEstimates.get(1);
  expect(read().cpuEstimates.get(1)).toEqual({ ...initial, creationTime: 1, cpuMs: 1_000 });

  metrics = [];
  expect(read().cpuEstimates.has(1)).toBe(false);
  metrics = [metric(1, 100)];
  const restored = read().cpuEstimates.get(1)!;
  expect(restored.cpuMs).toBe(0);
  expect(restored.generation).not.toBe(initial?.generation);

  metrics = [metric(1, 100, 2)];
  const reused = read().cpuEstimates.get(1)!;
  expect(reused.cpuMs).toBe(0);
  expect(reused.generation).not.toBe(restored.generation);

  metrics[0].cpu.cumulativeCPUUsage = 10;
  expect(read().cpuEstimates.has(1)).toBe(false);
  metrics = [metric(1, 100, 2)];
  expect(read().cpuEstimates.get(1)).toMatchObject({ cpuMs: 0 });
});
