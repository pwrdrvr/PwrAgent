import fc from "fast-check";
import fs from "node:fs/promises";
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
  stopCounterWraps?: boolean;
  failedCpuRead?: number;
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
  const rotationCpuMs = input.stopCpuMs + input.startCpuMs;
  const rotationWallMs = rotationCpuMs + input.blockedWithoutCpuMs;
  const elapsedMs = rotationWallMs + SAMPLE_MS * (input.skipMetric ? 2 : 1);
  const applicationCpuMs = elapsedMs * input.appCpuPercent / 100;
  const measuredStopCpuMs = input.stopCounterWraps || input.failedCpuRead === 1 || input.failedCpuRead === 2
    ? 0
    : input.stopCpuMs;
  const measuredStartCpuMs = input.failedCpuRead === 3 || input.failedCpuRead === 4 ? 0 : input.startCpuMs;
  const measuredRotationCpuMs = measuredStopCpuMs + measuredStartCpuMs;
  const expectedPercent = 100 * (applicationCpuMs + rotationCpuMs - measuredRotationCpuMs) / elapsedMs;
  const threadCpuWrapMs = 24 * 60 * 60 * 1_000;
  let observerCpuMs = input.stopCounterWraps ? threadCpuWrapMs - 1 : 0;
  let cpuReads = 0;
  let processCpuMs = 0;
  let elapsedDuringRotationMs = 0;
  let attached = false;
  let starts = 0;
  let recordingStartedAt = 0;
  let initialRecordingStart = 0;
  let metricAvailable = true;
  const target: HotCpuTarget & { readProfilerThreadCpuMicros: () => number } = {
    getOSProcessId: () => 1,
    readProfilerThreadCpuMicros: () => {
      if (++cpuReads === input.failedCpuRead) throw new Error("Thread CPU clock unavailable");
      return observerCpuMs * 1_000;
    },
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
          if (starts === 1) initialRecordingStart = recordingStartedAt;
        }
        if (method === "Profiler.stop") {
          const endTime = (Date.now() + elapsedDuringRotationMs) * 1_000;
          if (starts === 1) {
            observerCpuMs += input.stopCpuMs;
            if (input.stopCounterWraps) observerCpuMs %= threadCpuWrapMs;
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
      rules: [{ id: "spike", sampleCount: 1, thresholdPercent: THRESHOLD_PERCENT, durationMs: SAMPLE_MS }],
      thresholdPercent: THRESHOLD_PERCENT, slowburnThresholdPercent: 20, consecutiveSamples: 2,
      profileDurationMs: 50, maxProfiles: 1, cooldownMs: 60_000,
      captureHeapSnapshot: false, heapSnapshotLimit: 0,
    },
    target,
    session,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    now: () => new Date(Date.now() + elapsedDuringRotationMs),
    sampleNow: () => Date.now() + elapsedDuringRotationMs,
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
    if (input.skipMetric) {
      expect(sample.cpuMeasurementSource).toBe("baseline");
      expect(sample.wallDeltaSeconds).toBeUndefined();
      expect(events.some((event) => event.type === "profile-started")).toBe(false);
      processCpuMs += 100;
      await vi.advanceTimersByTimeAsync(SAMPLE_MS);
      expect(samples.at(-1)?.cpuPercent).toBeCloseTo(5, 8);
      expect(samples.at(-1)?.recorderRotationCpuSeconds).toBeUndefined();
      return;
    }
    expect(sample.cumulativeCpuDeltaSeconds).toBeCloseTo((applicationCpuMs + rotationCpuMs) / 1_000, 8);
    expect(sample.wallDeltaSeconds).toBeCloseTo(elapsedMs / 1_000, 8);
    expect(sample.cpuPercent).toBeCloseTo(expectedPercent, 8);
    expect(sample.recorderRotationCpuSeconds ?? 0).toBeCloseTo(measuredRotationCpuMs / 1_000, 8);

    const profileStarted = events.some((event) => event.type === "profile-started");
    // The oracle and recorder use different arithmetic on floating-point CPU
    // counters. Check trigger decisions away from rounding ties.
    if (Math.abs(expectedPercent - THRESHOLD_PERCENT) > 1e-8) {
      expect(profileStarted).toBe(expectedPercent >= THRESHOLD_PERCENT);
    }
    if (profileStarted) {
      await profiler.stop();
      const profile = JSON.parse(await fs.readFile(session.createProfilePath(1), "utf8"));
      expect(profile.startTime).toBe(initialRecordingStart);
    } else {
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

it("uses the valid start measurement when the thread CPU counter wraps during stop", async () => {
  await exerciseRotation({
    stopCpuMs: 75, startCpuMs: 20, blockedWithoutCpuMs: 0, appCpuPercent: 10,
    skipMetric: false, stopCounterWraps: true,
  });
});

it.each([1, 2, 3, 4])("retains the recorder and detects a spike when rotation CPU read %i fails", async (failedCpuRead) => {
  await exerciseRotation({
    stopCpuMs: 75, startCpuMs: 20, blockedWithoutCpuMs: 0, appCpuPercent: 55,
    skipMetric: false, failedCpuRead,
  });
});

it("uses application CPU over the actual sample interval across recorder rotations", async () => {
  await fc.assert(fc.asyncProperty(fc.record({
    stopCpuMs: fc.integer({ min: 10, max: 350 }),
    startCpuMs: fc.integer({ min: 0, max: 35 }),
    blockedWithoutCpuMs: fc.integer({ min: 0, max: 200 }),
    appCpuPercent: fc.oneof(fc.integer({ min: 0, max: 49 }), fc.integer({ min: 51, max: 95 })),
    skipMetric: fc.boolean(),
    failedCpuRead: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  }), exerciseRotation), { numRuns: 30 });
});

it("still emits throttled hot-CPU warnings after maxProfiles is reached", async () => {
  vi.useFakeTimers();
  const samples: HotCpuProfileSample[] = [];
  const events: HotCpuProfileEvent[] = [];
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  let processCpuMs = 0;
  let attached = false;
  const session: HotCpuProfileSession = {
    target: "main",
    id: "cap-warn",
    directoryName: "cap-warn",
    directoryPath: workspace.path,
    samplesPath: "",
    eventsPath: "",
    appendSample: async (sample) => { samples.push(sample); },
    appendEvent: async (event) => { events.push(event); },
    createProfilePath: (index) => path.join(workspace.path, `profile-${index}.cpuprofile`),
    createHeapSnapshotPath: () => "",
    registerArtifact: async () => {},
  };
  const target: HotCpuTarget = {
    getOSProcessId: () => 1,
    debugger: {
      attach: () => { attached = true; },
      detach: () => { attached = false; },
      isAttached: () => attached,
      on: () => {},
      off: () => {},
      sendCommand: async (method) => method === "Profiler.stop"
        ? { profile: { nodes: [{ id: 1, callFrame: { functionName: "(root)" } }], startTime: 0, endTime: 1000, samples: [], timeDeltas: [] } }
        : {},
    },
  };
  let resolveProfileWritten: (() => void) | undefined;
  const profileWritten = new Promise<void>((resolve) => {
    resolveProfileWritten = resolve;
  });
  const profiler = new HotCpuProfiler({
    config: {
      enabled: true, repoRoot: workspace.path, outputRoot: workspace.path,
      intervalMs: SAMPLE_MS, startDelayMs: 0, triggerMode: "spike",
      rules: [{ id: "spike", sampleCount: 1, thresholdPercent: THRESHOLD_PERCENT, durationMs: SAMPLE_MS }],
      thresholdPercent: THRESHOLD_PERCENT, slowburnThresholdPercent: 20, consecutiveSamples: 2,
      profileDurationMs: 50, maxProfiles: 1, cooldownMs: 60_000,
      captureHeapSnapshot: false, heapSnapshotLimit: 0,
    },
    target,
    session,
    logger,
    onProfileWritten: async () => { resolveProfileWritten?.(); },
    now: () => new Date(Date.now()),
    sampleNow: () => Date.now(),
    getAppMetrics: () => [{
      pid: 1, type: "Browser", creationTime: 0,
      cpu: { cumulativeCPUUsage: processCpuMs / 1_000, percentCPUUsage: 0, idleWakeupsPerSecond: 0 },
      memory: { workingSetSize: 0, peakWorkingSetSize: 0 },
    } as ProcessMetric],
  });
  try {
    await profiler.start();
    // Baseline sample.
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    // First spike consumes maxProfiles (1).
    processCpuMs += 1_800;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    await vi.advanceTimersByTimeAsync(100);
    await profileWritten;
    await Promise.resolve();
    expect(events.filter((event) => event.type === "profile-written")).toHaveLength(1);

    // Baseline sample after profile completion resets the delta window.
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);

    // Within cooldown: no cap warning yet.
    logger.warn.mockClear();
    processCpuMs += 1_800;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(logger.warn).not.toHaveBeenCalled();

    // Past cooldown: hot CPU still logs a throttled warning even though maxProfiles was reached.
    await vi.advanceTimersByTimeAsync(60_000);
    processCpuMs += 1_800;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(logger.warn).toHaveBeenCalledWith(
      "[pwragent:hot-cpu] hot CPU detected after profile cap reached",
      expect.objectContaining({ target: "main", profileCount: 1, maxProfiles: 1 }),
    );
    expect(events.filter((event) => event.type === "profile-cap-warning")).toHaveLength(1);
    // Throttled again on the immediately following sample.
    logger.warn.mockClear();
    processCpuMs += 1_800;
    await vi.advanceTimersByTimeAsync(SAMPLE_MS);
    expect(logger.warn).not.toHaveBeenCalled();
  } finally {
    await profiler.stop();
    vi.useRealTimers();
  }
});
