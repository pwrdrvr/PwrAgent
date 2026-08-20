import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "../testing/test-harness";
import type { ProcessMetric } from "electron";
import { resolveHotCpuProfileConfig } from "../diagnostics/hot-cpu-profile-config";
import { createHotCpuProfileSession } from "../diagnostics/hot-cpu-profile-session";
import { RendererHotCpuProfiler } from "../diagnostics/renderer-hot-cpu-profiler";

function createEnabledConfig(
  repoRoot: string,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  const config = resolveHotCpuProfileConfig({
    env: {
      PWRAGENT_HOT_CPU_PROFILING: "1",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "5",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "50",
      PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "2",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "10",
      PWRAGENT_HOT_CPU_PROFILING_COOLDOWN_MS: "20",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "2",
      ...envOverrides,
    },
    repoRoot,
  });

  expect(config.enabled).toBe(true);
  if (!config.enabled) {
    throw new Error("Expected hot CPU profiling to be enabled.");
  }

  return config;
}

function createMetric(
  percentCPUUsage: number,
  cumulativeCPUUsage = 42,
): ProcessMetric {
  return {
    pid: 1234,
    type: "Tab",
    serviceName: "Tab",
    name: "PwrAgent Renderer",
    cpu: {
      percentCPUUsage,
      cumulativeCPUUsage,
      idleWakeupsPerSecond: 3,
    },
    creationTime: 1_780_000_000_000,
    memory: {
      workingSetSize: 512 * 1024,
      peakWorkingSetSize: 1024 * 1024,
    },
  } as ProcessMetric;
}

function createTarget() {
  let attached = false;
  let destroyed = false;
  const debuggerApi = {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (method: string) => {
      if (method === "Profiler.stop") {
        return {
          profile: {
            nodes: [{ id: 1, callFrame: { functionName: "(root)", url: "" } }],
            samples: [],
            timeDeltas: [],
          },
        };
      }

      return {};
    }),
    on: vi.fn(),
    off: vi.fn(),
  };

  return {
    target: {
      debugger: debuggerApi,
      getOSProcessId: vi.fn(() => 1234),
      isDestroyed: vi.fn(() => destroyed),
      takeHeapSnapshot: vi.fn(async (_filePath: string) => undefined),
    },
    debuggerApi,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
  };
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

/**
 * Progress-based synchronization for the sampling loop.
 *
 * `vi.waitFor` polls against a wall-clock budget (1s by default) while one
 * sampling iteration awaits real disk writes, so on a loaded CI runner the
 * budget expires before the loop has advanced and this suite flakes while
 * passing locally. It is also not side-effect free under fake timers: it
 * advances them between retries, which drives the very loop being measured
 * (see the sample-count comment further down for the flake that caused).
 *
 * Waiting on the profiler's own `onSampleCaptured` signal removes the clock
 * from both problems — the wait ends when the work actually finishes, bounded
 * only by the test timeout, and nothing is stepped forward to find that out.
 */
function createSampleTracker() {
  let captured = 0;
  let waiters: Array<{
    label: string;
    ready: () => boolean;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  function flush(): void {
    waiters = waiters.filter((waiter) => {
      // A predicate that throws would otherwise escape through the profiler's
      // `finally`, rejecting the sampling chain and leaving this wait pending
      // forever. Fail the wait that owns the predicate instead.
      let ready: boolean;
      try {
        ready = waiter.ready();
      } catch (error) {
        waiter.reject(error);
        return false;
      }
      if (!ready) return true;
      waiter.resolve();
      return false;
    });
  }

  async function waitUntil(ready: () => boolean, label: string): Promise<void> {
    if (ready()) return;
    await new Promise<void>((resolve, reject) => {
      waiters.push({ label, ready, resolve, reject });
    });
  }

  return {
    onSampleCaptured: () => {
      captured += 1;
      flush();
    },
    /**
     * Waits still outstanding. Non-empty only after a test has already failed,
     * since every wait is awaited — see the afterEach that reports them.
     */
    pendingLabels: (): string[] =>
      waiters.map((waiter) => `${waiter.label} (after ${captured} samples)`),
    waitUntil,
    /** Resolves once `target` sampling iterations have fully completed. */
    async waitForCount(target: number): Promise<void> {
      await waitUntil(() => captured >= target, `${target} completed samples`);
    },
  };
}

describe("RendererHotCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const profilers: RendererHotCpuProfiler[] = [];

  const sampleTrackers = new WeakMap<
    RendererHotCpuProfiler,
    ReturnType<typeof createSampleTracker>
  >();

  function createProfiler(
    options: ConstructorParameters<typeof RendererHotCpuProfiler>[0],
  ): RendererHotCpuProfiler {
    const tracker = createSampleTracker();
    const profiler = new RendererHotCpuProfiler({
      ...options,
      onSampleCaptured: () => {
        options.onSampleCaptured?.();
        tracker.onSampleCaptured();
      },
    });
    sampleTrackers.set(profiler, tracker);
    profilers.push(profiler);
    return profiler;
  }

  /** Sampling-progress tracker for a profiler built by `createProfiler`. */
  function samplesOf(
    profiler: RendererHotCpuProfiler,
  ): ReturnType<typeof createSampleTracker> {
    const tracker = sampleTrackers.get(profiler);
    if (!tracker) {
      throw new Error("Profiler was not created through createProfiler().");
    }
    return tracker;
  }

  afterEach(async () => {
    vi.useRealTimers();
    const created = profilers.splice(0);
    const pendingWaits = created.flatMap(
      (profiler) => sampleTrackers.get(profiler)?.pendingLabels() ?? [],
    );
    await Promise.all(created.map((profiler) => profiler.stop("test-cleanup")));
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
    if (pendingWaits.length > 0) {
      // Reachable only when the test has already failed, because every wait is
      // awaited. It turns an opaque "Test timed out in 5000ms" into the name of
      // the thing that never happened — the diagnostic `vi.waitFor` used to
      // give for free by reporting the assertion it was retrying.
      throw new Error(
        `Sampling waits never resolved: ${pendingWaits.join("; ")}`,
      );
    }
  });

  it("records a renderer CPU profile after sustained hot samples", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target, debuggerApi } = createTarget();
    const onProfileWritten = vi.fn(async () => undefined);
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
      onProfileWritten,
    });

    await profiler.start();
    await samplesOf(profiler).waitUntil(
      () => debuggerApi.attach.mock.calls.length > 0,
      "debugger attach",
    );
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");

    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(1, "Profiler.enable");
    expect(debuggerApi.sendCommand).toHaveBeenNthCalledWith(2, "Profiler.start");

    await vi.waitFor(async () => {
      const profile = JSON.parse(
        await fs.readFile(
          sessionResult.session.createProfilePath(1),
          "utf8",
        ),
      );
      expect(profile).toMatchObject({ nodes: [{ id: 1 }] });
    });

    await profiler.stop("test-complete");

    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    expect(debuggerApi.detach).toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onProfileWritten).toHaveBeenCalledWith(
        expect.objectContaining({
          profileFilename: "renderer-hot-0001.cpuprofile",
          profilePath: sessionResult.session.createProfilePath(1),
          sessionDirectory: sessionResult.session.directoryPath,
          sessionDirectoryName: sessionResult.session.directoryName,
          triggerConsecutiveSamples: 2,
          triggerCpuPercent: 75,
          triggerMode: "sustained",
          triggerThresholdPercent: 50,
        }),
      );
    });

    const profile = JSON.parse(
      await fs.readFile(
        sessionResult.session.createProfilePath(1),
        "utf8",
      ),
    );
    expect(profile).toMatchObject({ nodes: [{ id: 1 }] });

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const samples = (await fs.readFile(sessionResult.session.samplesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "profile-started" }),
        expect.objectContaining({ type: "profile-written" }),
      ]),
    );
    expect(samples).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cpuPercent: 75,
          electronCpuPercent: 4,
          cumulativeCpuDeltaSeconds: 1.5,
          wallDeltaSeconds: 2,
        }),
      ]),
    );
  });

  it("waits for an in-flight duration profile stop before stopping the monitor", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target } = createTarget();
    const profileWritten = deferred();
    const profileWriteStarted = deferred();
    const onProfileWritten = vi.fn(async () => {
      profileWriteStarted.resolve();
      await profileWritten.promise;
    });
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
      onProfileWritten,
    });

    await profiler.start();
    // Not a sample-progress wait: sampling is paused for the duration of a
    // profile, so the loop publishes nothing more until the profile ends —
    // and this test deliberately holds `onProfileWritten` open forever.
    await profileWriteStarted.promise;
    expect(onProfileWritten).toHaveBeenCalledTimes(1);

    let stopResolved = false;
    const stopPromise = profiler.stop("test-complete").then(() => {
      stopResolved = true;
    });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    profileWritten.resolve();
    await stopPromise;
    expect(stopResolved).toBe(true);
  });

  it("waits for an in-flight sample before allowing session cleanup", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "100",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const sampleWrite = deferred();
    const originalAppendSample = sessionResult.session.appendSample;
    sessionResult.session.appendSample = vi.fn(async (sample) => {
      await sampleWrite.promise;
      await originalAppendSample(sample);
    });
    const appendEvent = vi.spyOn(sessionResult.session, "appendEvent");
    const { target } = createTarget();
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [createMetric(0, 100)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await profiler.start();
    vi.advanceTimersByTime(0);
    expect(sessionResult.session.appendSample).toHaveBeenCalledTimes(1);

    const stopPromise = profiler.stop("test-complete");
    let concurrentStopResolved = false;
    const concurrentStopPromise = profiler.stop("duplicate-stop").then(() => {
      concurrentStopResolved = true;
    });
    await Promise.resolve();
    const waitedForSample = !appendEvent.mock.calls.some(
      ([event]) => event.type === "monitor-stopped",
    );
    const concurrentStopWaited = !concurrentStopResolved;
    sampleWrite.resolve();
    await Promise.all([stopPromise, concurrentStopPromise]);
    expect(waitedForSample).toBe(true);
    expect(concurrentStopWaited).toBe(true);
    expect(
      appendEvent.mock.calls.filter(([event]) => event.type === "monitor-stopped"),
    ).toEqual([
      [
        expect.objectContaining({
          detail: { reason: "test-complete" },
        }),
      ],
    ]);

    const appendSampleCalls = vi.mocked(sessionResult.session.appendSample).mock
      .calls.length;
    const appendEventCalls = appendEvent.mock.calls.length;
    await workspace.cleanup();
    await vi.advanceTimersByTimeAsync(config.intervalMs * 2);

    expect(sessionResult.session.appendSample).toHaveBeenCalledTimes(appendSampleCalls);
    expect(appendEvent).toHaveBeenCalledTimes(appendEventCalls);
    await expect(fs.access(sessionResult.session.directoryPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("pauses process metric sampling while the renderer CPU profiler is active", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "10000",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const { target, debuggerApi } = createTarget();
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 100.5),
      createMetric(4, 101),
      createMetric(0, 110),
    ];
    const getAppMetrics = vi.fn(() => [metrics.shift() ?? createMetric(0, 101)]);
    const profiler = createProfiler({
      config,
      getAppMetrics,
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 5),
    });

    try {
      await profiler.start();
      await vi.advanceTimersByTimeAsync(0);
      await samplesOf(profiler).waitForCount(1);
      expect(getAppMetrics).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(2);
      expect(getAppMetrics).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(3);
      expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");

      expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.start");
      expect(getAppMetrics).toHaveBeenCalledTimes(3);
      // The sample signal fires after profile-start bookkeeping has armed the
      // duration timer, so it is already the only pending timer here.
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(config.intervalMs * 4);
      expect(getAppMetrics).toHaveBeenCalledTimes(3);
      expect(debuggerApi.sendCommand).not.toHaveBeenCalledWith("Profiler.stop");

      await vi.runOnlyPendingTimersAsync();
      expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
      await vi.waitFor(() => expect(debuggerApi.detach).toHaveBeenCalled());

      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(4);
      expect(getAppMetrics).toHaveBeenCalledTimes(4);

      // Stop the profiler BEFORE asserting the sample file. The sampler is a
      // self-rescheduling setTimeout loop, and `vi.waitFor` advances fake
      // timers between retries — so a `waitFor(() => toHaveLength(4))` against
      // a still-running loop drives the loop forward each retry, growing the
      // file past 4 and never settling (the CI flake: "expected length 4, got
      // 23"). `stop()` clears the interval timer and latches `stopped`, after
      // which `scheduleNextSample` no-ops, freezing the count at the 4 samples
      // already confirmed via getAppMetrics above. It's idempotent, so the
      // `finally` stop below is a safe no-op.
      await profiler.stop("test-complete");

      let samples: Array<Record<string, unknown>> = [];
      await vi.waitFor(async () => {
        samples = (await fs.readFile(sessionResult.session.samplesPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(samples).toHaveLength(4);
      });
      expect(samples.at(-1)).toMatchObject({
        cpuPercent: 0,
        cumulativeCpuSeconds: 110,
        electronCpuPercent: 0,
      });
      expect(samples.at(-1)).not.toHaveProperty("cumulativeCpuDeltaSeconds");
      expect(samples.at(-1)).not.toHaveProperty("wallDeltaSeconds");
    } finally {
      await profiler.stop("test-complete");
    }
  });

  it("waits for the configured delay before sampling", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "100",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const { target } = createTarget();
    const getAppMetrics = vi.fn(() => [createMetric(0, 100)]);
    const profiler = createProfiler({
      config,
      getAppMetrics,
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await profiler.start();
    await vi.advanceTimersByTimeAsync(99);
    expect(getAppMetrics).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(getAppMetrics).toHaveBeenCalledTimes(1);

    await profiler.stop("test-complete");
  });

  it("starts a profile after one hot sample in spike mode", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target, debuggerApi } = createTarget();
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.2),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
    });

    await profiler.start();
    await samplesOf(profiler).waitUntil(
      () => debuggerApi.attach.mock.calls.length > 0,
      "debugger attach",
    );
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    await profiler.stop("test-complete");

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "profile-started",
          detail: expect.objectContaining({
            triggerMode: "spike",
            triggerConsecutiveSamples: 1,
          }),
        }),
      ]),
    );
  });

  it("starts a profile after consecutive slowburn samples", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "slowburn",
      PWRAGENT_HOT_CPU_PROFILING_SLOWBURN_THRESHOLD_PERCENT: "15",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target, debuggerApi } = createTarget();
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(2, 100.4),
      createMetric(2, 100.8),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
    });

    await profiler.start();
    await samplesOf(profiler).waitUntil(
      () => debuggerApi.attach.mock.calls.length > 0,
      "debugger attach",
    );
    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    await profiler.stop("test-complete");

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "profile-started",
          detail: expect.objectContaining({
            triggerMode: "slowburn",
            triggerThresholdPercent: 15,
            triggerConsecutiveSamples: 2,
          }),
        }),
      ]),
    );
  });

  it("captures bounded heap snapshots around a hot CPU profile", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT: "1",
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT: "3",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const { target, debuggerApi } = createTarget();
    const onHeapSnapshotLimitReached = vi.fn(async () => undefined);
    const onProfileWritten = vi.fn();
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const getAppMetrics = vi.fn(() => [metrics.shift() ?? createMetric(0)]);
    const profiler = createProfiler({
      config,
      getAppMetrics,
      onHeapSnapshotLimitReached,
      onProfileWritten,
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
    });

    try {
      await profiler.start();

      await vi.advanceTimersByTimeAsync(config.startDelayMs);
      await samplesOf(profiler).waitForCount(1);
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(2);
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(3);
      expect(getAppMetrics).toHaveBeenCalledTimes(3);
      expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
      await vi.advanceTimersByTimeAsync(config.profileDurationMs);

      await vi.waitFor(() => {
        expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(3);
      });
      await vi.waitFor(() => {
        expect(onHeapSnapshotLimitReached).toHaveBeenCalledTimes(1);
      });
    } finally {
      await profiler.stop("test-complete");
    }

    const snapshotFilenames = target.takeHeapSnapshot.mock.calls.map((call) =>
      // The product builds snapshot paths with path.join, so on Windows they
      // are backslash-separated. Normalize before extracting the basename so
      // the split works on every platform (no-op on POSIX).
      call[0].replace(/\\/g, "/").split("/").at(-1),
    );
    expect(snapshotFilenames).toEqual([
      "renderer-hot-0001-start.heapsnapshot",
      "renderer-hot-0001-mid.heapsnapshot",
      "renderer-hot-0001-stop.heapsnapshot",
    ]);
    expect(onProfileWritten).toHaveBeenCalledWith(
      expect.objectContaining({
        heapSnapshotArtifacts: [
          {
            filename: "renderer-hot-0001-start.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "start"),
            phase: "start",
          },
          {
            filename: "renderer-hot-0001-mid.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "mid"),
            phase: "mid",
          },
          {
            filename: "renderer-hot-0001-stop.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "stop"),
            phase: "stop",
          },
        ],
        profileFilename: "renderer-hot-0001.cpuprofile",
        profilePath: sessionResult.session.createProfilePath(1),
      }),
    );

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "heap-snapshot-written",
          detail: expect.objectContaining({ phase: "start", snapshotNumber: 1 }),
        }),
        expect.objectContaining({
          type: "heap-snapshot-written",
          detail: expect.objectContaining({ phase: "mid", snapshotNumber: 2 }),
        }),
        expect.objectContaining({
          type: "heap-snapshot-written",
          detail: expect.objectContaining({ phase: "stop", snapshotNumber: 3 }),
        }),
        expect.objectContaining({ type: "heap-snapshot-limit-reached" }),
      ]),
    );
  });

  it("waits for an in-flight heap snapshot before handing off profile artifacts", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "1000",
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT: "1",
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT: "3",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const midSnapshot = deferred();
    const { target, debuggerApi } = createTarget();
    target.takeHeapSnapshot.mockImplementation(async (filePath: string) => {
      if (filePath.includes("-mid.")) {
        await midSnapshot.promise;
      }
    });
    const onProfileWritten = vi.fn();
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [createMetric(89)],
      onProfileWritten,
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          cpuPercent: number;
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      cpuPercent: 89,
      pid: 1234,
    });

    const midCapture = (
      profiler as unknown as {
        captureHeapSnapshot: (index: number, phase: string) => Promise<void>;
      }
    ).captureHeapSnapshot(1, "mid");
    await vi.waitFor(() => {
      expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(2);
    });

    const stopProfile = (
      profiler as unknown as { stopProfile: (reason: string) => Promise<void> }
    ).stopProfile("duration-elapsed");
    await vi.waitFor(() => {
      expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    });

    expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(2);
    expect(onProfileWritten).not.toHaveBeenCalled();

    midSnapshot.resolve();
    await Promise.all([midCapture, stopProfile]);

    expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(3);
    expect(onProfileWritten).toHaveBeenCalledWith(
      expect.objectContaining({
        heapSnapshotArtifacts: [
          {
            filename: "renderer-hot-0001-start.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "start"),
            phase: "start",
          },
          {
            filename: "renderer-hot-0001-mid.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "mid"),
            phase: "mid",
          },
          {
            filename: "renderer-hot-0001-stop.heapsnapshot",
            path: sessionResult.session.createHeapSnapshotPath(1, "stop"),
            phase: "stop",
          },
        ],
        profileFilename: "renderer-hot-0001.cpuprofile",
        profilePath: sessionResult.session.createProfilePath(1),
      }),
    );
  });

  it("does not schedule heap or duration timers after being stopped during the start heap snapshot", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "100",
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT: "1",
      PWRAGENT_HOT_CPU_PROFILING_HEAP_SNAPSHOT_LIMIT: "3",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const startSnapshot = deferred();
    const startSnapshotRequested = deferred();
    const { target, debuggerApi } = createTarget();
    target.takeHeapSnapshot.mockImplementation(async () => {
      startSnapshotRequested.resolve();
      await startSnapshot.promise;
    });
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
    });

    await profiler.start();
    // Not a sample-progress wait: the start snapshot is awaited inside the
    // sampling iteration and this test holds it open, so the iteration never
    // completes. Wait on the snapshot request instead.
    await startSnapshotRequested.promise;
    expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(1);

    const stopProfiler = profiler.stop("settings-disabled");
    await vi.waitFor(() => {
      expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    });
    startSnapshot.resolve();
    await stopProfiler;
    await new Promise((resolve) =>
      setTimeout(resolve, config.profileDurationMs * 2),
    );

    expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(1);
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    expect(
      debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Profiler.stop"),
    ).toHaveLength(1);
  });

  it("skips profiling when a debugger is already attached", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target, debuggerApi } = createTarget();
    debuggerApi.isAttached.mockReturnValue(true);
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      now: () => new Date(1_780_000_000_000 + nowCallCount++ * 2_000),
    });

    await profiler.start();
    // The skip is recorded inside the sampling iteration that would have
    // started the profile, so three completed samples settle this file.
    await samplesOf(profiler).waitForCount(3);

    expect(debuggerApi.attach).not.toHaveBeenCalled();

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "profile-skipped",
          detail: expect.objectContaining({
            reason: "debugger-already-attached",
          }),
        }),
      ]),
    );

    await profiler.stop("test-complete");
  });

  it("clears the profile duration timer when profiling stops early", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const { target, debuggerApi } = createTarget();
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [createMetric(89)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          cpuPercent: number;
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      cpuPercent: 89,
      pid: 1234,
    });

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(vi.getTimerCount()).toBe(1);

    await profiler.stop("settings-disabled");

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20);
    expect(
      debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Profiler.stop"),
    ).toHaveLength(1);
  });

  it("waits for an in-flight duration stop before detaching", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    vi.useFakeTimers();

    const stopCommand = deferred<{ profile: { nodes: Array<{ id: number }> } }>();
    const { target, debuggerApi } = createTarget();
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Profiler.stop") {
        return stopCommand.promise;
      }

      return {};
    });
    const profiler = createProfiler({
      config,
      getAppMetrics: () => [createMetric(89)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          cpuPercent: number;
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      cpuPercent: 89,
      pid: 1234,
    });

    await vi.advanceTimersByTimeAsync(config.profileDurationMs);
    await vi.waitFor(() => {
      expect(
        debuggerApi.sendCommand.mock.calls.filter(
          ([method]) => method === "Profiler.stop",
        ),
      ).toHaveLength(1);
    });

    const stopPromise = profiler.stop("test-complete");
    await Promise.resolve();

    expect(debuggerApi.detach).not.toHaveBeenCalled();

    stopCommand.resolve({ profile: { nodes: [{ id: 1 }] } });
    await stopPromise;

    expect(debuggerApi.detach).toHaveBeenCalled();
  });

  it("does not query debugger attachment when the renderer is destroyed", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);

    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      createdAt: new Date(2026, 5, 1, 15, 30, 0),
      sessionId: "abc123",
      versions: {
        appVersion: "1.0.0",
        electronVersion: "41.2.1",
        chromeVersion: "146.0.0.0",
        nodeVersion: "24.0.0",
      },
    });
    expect(sessionResult.ok).toBe(true);
    if (!sessionResult.ok) return;

    const { target, debuggerApi, setDestroyed } = createTarget();
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Profiler.stop") {
        throw new Error("Object has been destroyed");
      }

      return {};
    });

    const profiler = createProfiler({
      config,
      getAppMetrics: () => [createMetric(89)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    });

    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          cpuPercent: number;
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      cpuPercent: 89,
      pid: 1234,
    });

    expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    debuggerApi.isAttached.mockClear();
    debuggerApi.detach.mockClear();
    setDestroyed(true);

    await profiler.stop("render-process-gone");

    expect(debuggerApi.isAttached).not.toHaveBeenCalled();
    expect(debuggerApi.detach).not.toHaveBeenCalled();

    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "profile-stop-failed",
          detail: expect.objectContaining({
            reason: "render-process-gone",
          }),
        }),
        expect.objectContaining({
          type: "monitor-stopped",
          detail: expect.objectContaining({
            reason: "render-process-gone",
          }),
        }),
      ]),
    );
  });
});
