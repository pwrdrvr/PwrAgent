import fc from "fast-check";
import path from "node:path";
import type { ProcessMetric } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HotCpuTarget } from "../diagnostics/hot-cpu-target";
import type { HotCpuProfileEvent, HotCpuProfileSample, HotCpuProfileSession } from "../diagnostics/hot-cpu-profile-session";
import { HotCpuProfiler } from "../shell/diagnostics/hot-cpu-profiler";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";

const SAMPLE_MS = 2_000;
const ROTATE_MS = 30_000;
const THRESHOLD_PERCENT = 50;

type Rotation = {
  stopCpuMs: number;
  startCpuMs: number;
  blockedWithoutCpuMs: number;
  appCpuPercent: number;
  skipMetric: boolean;
};

let workspace: Awaited<ReturnType<typeof createTemporaryTestDirectory>>;

beforeEach(async () => {
  workspace = await createTemporaryTestDirectory();
});

afterEach(async () => {
  vi.useRealTimers();
  await workspace.cleanup();
});

async function exerciseRotation(input: Rotation): Promise<void> {
  vi.useFakeTimers();
  const samples: HotCpuProfileSample[] = [];
  const events: HotCpuProfileEvent[] = [];
  const session: HotCpuProfileSession = {
    target: "main",
    id: "test",
    directoryName: "test",
    directoryPath: workspace.path,
    samplesPath: "",
    eventsPath: "",
    appendSample: async (sample) => { samples.push(sample); },
    appendEvent: async (event) => { events.push(event); },
    createProfilePath: () => path.join(workspace.path, "profile.cpuprofile"),
    createHeapSnapshotPath: () => "",
    registerArtifact: async () => {},
  };
  const shouldTrigger = input.appCpuPercent > THRESHOLD_PERCENT;
  const rotationCpuMs = input.stopCpuMs + input.startCpuMs;
  const rotationWallMs = rotationCpuMs + input.blockedWithoutCpuMs;
  const elapsedMs = rotationWallMs + SAMPLE_MS * (input.skipMetric ? 2 : 1);
  const applicationCpuMs = elapsedMs * input.appCpuPercent / 100;
  let observerCpuMs = 0;
  let processCpuMs = 0;
  let elapsedDuringRotationMs = 0;
  let attached = false;
  let starts = 0;
  let recordingStartedAt = 0;
  let metricAvailable = true;
  const target: HotCpuTarget & { readProfilerThreadCpuMicros: () => number } = {
    getOSProcessId: () => 1,
    readProfilerThreadCpuMicros: () => observerCpuMs * 1_000,
    debugger: {
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      isAttached: () => attached,
      on: () => {},
      off: () => {},
      sendCommand: async (method) => {
        if (method === "Profiler.start") {
          if (++starts === 2) {
            observerCpuMs += input.startCpuMs;
            processCpuMs += input.startCpuMs;
            elapsedDuringRotationMs += input.startCpuMs;
          }
          recordingStartedAt = (Date.now() + elapsedDuringRotationMs) * 1_000;
        }
        if (method === "Profiler.stop") {
          const endTime = (Date.now() + elapsedDuringRotationMs) * 1_000;
          if (starts === 1) {
            observerCpuMs += input.stopCpuMs;
            // The process counter also includes application work on other threads
            // while the main thread is blocked inside the inspector.
            processCpuMs += input.stopCpuMs + applicationCpuMs / 4;
            elapsedDuringRotationMs += input.stopCpuMs + input.blockedWithoutCpuMs;
          }
          return {
            profile: {
              nodes: [{ id: 1, callFrame: { functionName: "(root)" } }],
              startTime: recordingStartedAt,
              endTime,
              samples: [],
              timeDeltas: [],
            },
          };
        }
        return {};
      },
    },
  };
  const profiler = new HotCpuProfiler({
    config: {
      enabled: true, repoRoot: workspace.path, outputRoot: workspace.path,
      intervalMs: SAMPLE_MS, startDelayMs: 0, triggerMode: "spike",
      thresholdPercent: THRESHOLD_PERCENT, slowburnThresholdPercent: 20, consecutiveSamples: 2,
      profileDurationMs: 50, maxProfiles: 1, cooldownMs: 60_000,
      captureHeapSnapshot: false, heapSnapshotLimit: 0,
    },
    target,
    session,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date(Date.now() + elapsedDuringRotationMs),
    getAppMetrics: () => metricAvailable ? [{
      pid: 1, type: "Browser", creationTime: 0,
      cpu: { cumulativeCPUUsage: processCpuMs / 1_000, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 0, peakWorkingSetSize: 0 },
    } as ProcessMetric] : [],
  });

  try {
    await profiler.start();
    await vi.advanceTimersByTimeAsync(ROTATE_MS + 1);
    expect(starts).toBe(2);
    metricAvailable = !input.skipMetric;
    if (input.skipMetric) await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    metricAvailable = true;
    processCpuMs += applicationCpuMs * 3 / 4;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);

    const sample = samples.at(-1)!;
    expect(sample.cumulativeCpuDeltaSeconds).toBeCloseTo((applicationCpuMs + rotationCpuMs) / 1_000, 8);
    expect(sample.wallDeltaSeconds).toBeCloseTo(elapsedMs / 1_000, 8);
    expect(events.some((event) => event.type === "profile-started")).toBe(shouldTrigger);
    expect(sample.cpuPercent).toBeCloseTo(input.appCpuPercent, 8);
    expect(sample.recorderRotationCpuSeconds).toBeCloseTo(rotationCpuMs / 1_000, 8);

    if (!shouldTrigger) {
      processCpuMs += 100;
      await vi.advanceTimersByTimeAsync(SAMPLE_MS);
      expect(samples.at(-1)?.cpuPercent).toBeCloseTo(5, 8);
      expect(samples.at(-1)?.recorderRotationCpuSeconds).toBeUndefined();
    }
  } finally {
    await profiler.stop();
    vi.useRealTimers();
  }
}

it("keeps a cold application sample below the spike threshold after an expensive rotation", async () => {
  await exerciseRotation({ stopCpuMs: 300, startCpuMs: 20, blockedWithoutCpuMs: 25, appCpuPercent: 45, skipMetric: false });
});

it("uses application CPU over the actual sample interval across recorder rotations", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    stopCpuMs: fc.integer({ min: 10, max: 350 }),
    startCpuMs: fc.integer({ min: 0, max: 35 }),
    blockedWithoutCpuMs: fc.integer({ min: 0, max: 200 }),
    appCpuPercent: fc.oneof(fc.integer({ min: 0, max: 49 }), fc.integer({ min: 51, max: 95 })),
    skipMetric: fc.boolean(),
  }), exerciseRotation), { numRuns: 30 });
});
