import { createAppMetricsReader } from "../shell/diagnostics/app-metrics";
import { migrateHotCpuCaptureRules } from "@pwragent/shared/hot-cpu-rules";
import type { HotCpuRuleMatch } from "../../shared/hot-cpu-profile";
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createTemporaryTestDirectory } from "../shell/testing/test-harness";
import type { ProcessMetric } from "electron";
import { resolveHotCpuProfileConfig } from "../diagnostics/hot-cpu-profile-config";
import { ChromiumTrace, ChromiumTraceExportError } from "../diagnostics/chromium-trace";
import { createHotCpuProfileSession } from "../diagnostics/hot-cpu-profile-session";
import { acquireDebuggerLease } from "../diagnostics/debugger-lease";
import { HotCpuProfiler } from "../shell/diagnostics/hot-cpu-profiler";
import { createMainProcessHotCpuTarget } from "../diagnostics/main-process-hot-cpu-target";

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
  const detached = deferred<void>();
  const debuggerApi = {
    attach: vi.fn(() => {
      attached = true;
    }),
    detach: vi.fn(() => {
      attached = false;
      detached.resolve();
    }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (method: string): Promise<unknown> => {
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
    detached: detached.promise,
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

describe("HotCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];
  const profilers: HotCpuProfiler[] = [];

  it("arms listing history only for the monitor lifetime and clears it before debugger detach", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path);
    const session = await createHotCpuProfileSession({ config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version } });
    if (!session.ok) throw new Error(session.message);
    const { target, debuggerApi } = createTarget();
    const enabled = vi.fn((value: boolean) => {
      expect(debuggerApi.isAttached()).toBe(true);
      return value;
    });
    const profiler = createProfiler({ config, session: session.session, target: { ...target,
      setListingDiagnosticsEnabled: (value) => { enabled(value); } },
      getAppMetrics: () => [], logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    await profiler.rearmListingDiagnostics();
    expect(enabled).not.toHaveBeenCalled();
    await profiler.start();
    expect(enabled.mock.calls).toEqual([[true]]);
    await profiler.rearmListingDiagnostics();
    expect(enabled.mock.calls).toEqual([[true], [true]]);
    await profiler.stop("fixture");
    expect(enabled.mock.calls).toEqual([[true], [true], [false]]);
    await profiler.rearmListingDiagnostics();
    await profiler.stop("again");
    expect(enabled).toHaveBeenCalledTimes(3);
  });

  const sampleTrackers = new WeakMap<
    HotCpuProfiler,
    ReturnType<typeof createSampleTracker>
  >();

  function createProfiler(
    options: ConstructorParameters<typeof HotCpuProfiler>[0],
  ): HotCpuProfiler {
    const tracker = createSampleTracker();
    let sampleTimeMs: number | undefined;
    const profiler = new HotCpuProfiler({
      sampleNow: () => (sampleTimeMs = sampleTimeMs === undefined
        ? performance.now()
        : sampleTimeMs + options.config.intervalMs),
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
    profiler: HotCpuProfiler,
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

  it.each([
    "settings-changed", "exhausted", "window-closed", "native-timeout", "filter-failed", "cpu-stop-failed", "trace-register-failed",
  ] as const)(
    "settles renderer trace ownership when %s",
    async (transition) => {
      const workspace = await createTemporaryTestDirectory();
      cleanups.push(workspace.cleanup);
      const stopDuringProfile = transition === "settings-changed" || transition === "cpu-stop-failed";
      const config = createEnabledConfig(workspace.path, {
        PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
        PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
        PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: stopDuringProfile ? "60000" : "10",
      });
      const created = await createHotCpuProfileSession({
        config, versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
      });
      if (!created.ok) throw new Error(created.message);
      if (transition === "trace-register-failed") {
        const writeFile = fs.writeFile;
        let failed = false;
        const manifestWrite = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
          if (!failed && String(args[0]).includes("session.json") && String(args[1]).includes(".trace.json")) {
            failed = true;
            throw new Error("Contrived trace registration failure");
          }
          return writeFile(...args);
        });
        onTestFinished(() => { manifestWrite.mockRestore(); });
      }
      let recording = false;
      const released = deferred<void>();
      const start = vi.fn(async () => { recording = true; });
      const dispose = vi.fn(() => {
        recording = false;
        released.resolve();
      });
      const read = vi.fn(async function* () {
        yield { data: JSON.stringify({ traceEvents: [] }) };
      });
      if (transition === "native-timeout") {
        read.mockImplementationOnce(async function* () {
          await released.promise;
          yield { data: JSON.stringify({ traceEvents: [] }) };
        });
      }
      const onProfileWritten = vi.fn();
      const { target, debuggerApi } = createTarget();
      if (transition === "cpu-stop-failed") {
        debuggerApi.sendCommand.mockImplementation(async (method) => {
          if (method === "Profiler.stop") throw new Error("Contrived profiler failure");
          return {};
        });
      }
      let cpu = 0;
      const written = deferred<void>();
      const profiler = createProfiler({
        config,
        chromiumTrace: new ChromiumTrace(
          () => ({ start, read, dispose }),
          async (chunks, signal) => {
            const result: Buffer[] = [];
            for await (const { data } of chunks) {
              signal.throwIfAborted();
              result.push(Buffer.from(data));
            }
            if (transition === "filter-failed") throw new ChromiumTraceExportError("worker", "filter");
            return { bytes: Buffer.concat(result), filterCpuMs: 12, filterElapsedMs: 18 };
          },
          vi.fn(), { stopTimeoutMs: transition === "native-timeout" ? 200 : undefined },
        ),
        target: transition === "trace-register-failed" ? { ...target, readDiagnostics: () => ({}) } : target,
        session: created.session,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        getAppMetrics: () => [createMetric(0, transition === "window-closed" ? 0 : (cpu += 0.005))],
        onProfileWritten: (event) => {
          onProfileWritten(event);
          written.resolve();
        },
      });
      await profiler.start();
      expect(recording).toBe(true);
      await samplesOf(profiler).waitForCount(2);
      if (transition === "settings-changed") {
        // Model the trace ring as a stream whose trigger data can be evicted
        // while the independently timed CPU profile is still recording.
        expect(profiler.hasActiveProfile).toBe(true);
        expect(read).toHaveBeenCalledOnce();
      }
      if (stopDuringProfile || transition === "window-closed") {
        await profiler.stop(transition);
      } else {
        await written.promise;
      }
      await released.promise;
      expect(recording).toBe(false);
      expect(start).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledTimes(transition === "window-closed" ? 0 : 1);
      const { directoryPath } = created.session;
      const { artifacts } = JSON.parse(await fs.readFile(`${directoryPath}/session.json`, "utf8"));
      if (transition === "window-closed" || transition === "cpu-stop-failed") {
        expect(artifacts).toEqual([]);
        expect(onProfileWritten).not.toHaveBeenCalled();
        expect((await fs.readdir(directoryPath)).filter((file) => file.endsWith(".trace.json"))).toEqual([]);
      } else {
        const traceFilename = "renderer-hot-0001.trace.json";
        const hasTrace = transition !== "native-timeout" && transition !== "filter-failed"
          && transition !== "trace-register-failed";
        expect(artifacts).toEqual([
          "renderer-hot-0001.cpuprofile",
          ...(hasTrace ? [traceFilename] : []),
          ...(transition === "trace-register-failed" ? ["renderer-hot-0001.diagnostics.json"] : []),
        ]);
        if (!hasTrace) {
          expect((await fs.readdir(directoryPath)).includes(traceFilename)).toBe(false);
        }
        expect(onProfileWritten).toHaveBeenCalledOnce();
        expect(onProfileWritten.mock.calls[0][0].chromiumTracePath).toBe(
          hasTrace ? created.session.createProfilePath(1).replace(/\.cpuprofile$/, ".trace.json") : undefined,
        );
        const events = (await fs.readFile(created.session.eventsPath, "utf8"))
          .trim().split("\n").map((line) => JSON.parse(line));
        if (transition === "native-timeout") {
          expect(events).toContainEqual(expect.objectContaining({
            type: "chromium-trace-failed",
            detail: expect.objectContaining({ status: "failed", phase: "stop", category: "timeout" }),
          }));
        }
        if (transition === "filter-failed") {
          expect(events).toContainEqual(expect.objectContaining({
            type: "chromium-trace-failed",
            detail: expect.objectContaining({ status: "failed", phase: "filter", category: "worker" }),
          }));
        }
      }
    },
  );

  // Exhaust the two completion orders after shutdown claims a triggered
  // profile, plus the case where startup fails with no shutdown owner.
  it.each(["failure-before-registration", "failure-after-delivery", "no-shutdown"] as const)(
    "keeps trace ownership consistent on a failed startup event with %s",
    async (order) => {
      const workspace = await createTemporaryTestDirectory();
      cleanups.push(workspace.cleanup);
      const config = createEnabledConfig(workspace.path, {
        PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
        PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "60000",
      });
      const created = await createHotCpuProfileSession({
        config, versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
      });
      if (!created.ok) throw new Error(created.message);
      const session = created.session;
      const startWrite = deferred();
      const firstStarted = deferred();
      const secondStarted = deferred();
      const registration = deferred();
      const stopReachedRegistration = deferred();
      const written = deferred<string | undefined>();
      const delivery = deferred();
      let cpu = 0;
      let sampleTimeMs = 0;
      const startTrace = vi.fn(async () => {});
      const profiler = createProfiler({
        config,
        chromiumTrace: new ChromiumTrace(() => ({
          start: startTrace,
          async *read() { yield { data: '{"traceEvents":[]}' }; },
          dispose() {},
        }), async (chunks) => {
          for await (const chunk of chunks) {
            return { bytes: Buffer.from(chunk.data), filterCpuMs: 12, filterElapsedMs: 18 };
          }
          throw new Error("Contrived trace stream was empty");
        }, vi.fn(), { monotonicNow: () => sampleTimeMs }),
        target: createTarget().target,
        session: {
          ...session,
          async appendEvent(event) {
            if (event.type === "profile-started") {
              if (event.detail?.index === 1) {
                firstStarted.resolve();
                await startWrite.promise;
              } else {
                secondStarted.resolve();
              }
            }
            await session.appendEvent(event);
          },
          async registerArtifact(filename) {
            if (filename === "renderer-hot-0001.cpuprofile") {
              stopReachedRegistration.resolve();
              await registration.promise;
            }
            await session.registerArtifact(filename);
          },
        },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        sampleNow: () => (sampleTimeMs += config.intervalMs),
        getAppMetrics: () => [createMetric(0, (cpu += 0.005))],
        onProfileWritten: async (event) => {
          written.resolve(event.chromiumTracePath);
          if (order === "failure-after-delivery") await delivery.promise;
        },
      });
      const failStart = () => startWrite.reject(new Error("Contrived startup event write failed"));
      try {
        await profiler.start();
        await firstStarted.promise;
        if (order === "no-shutdown") {
          failStart();
          await samplesOf(profiler).waitForCount(2);
          expect(startTrace).toHaveBeenCalledTimes(2);
          await secondStarted.promise;
          await profiler.stop("settings-changed");
        } else {
          const stopped = profiler.stop("settings-changed");
          await stopReachedRegistration.promise;
          if (order === "failure-before-registration") {
            failStart();
            await samplesOf(profiler).waitForCount(2);
            registration.resolve();
          } else {
            registration.resolve();
            await written.promise;
            failStart();
            await samplesOf(profiler).waitForCount(2);
            delivery.resolve();
          }
          await stopped;
        }
        const index = order === "no-shutdown" ? "0002" : "0001";
        const traceFilename = `renderer-hot-${index}.trace.json`;
        const { artifacts } = JSON.parse(await fs.readFile(`${session.directoryPath}/session.json`, "utf8"));
        expect(artifacts).toEqual([`renderer-hot-${index}.cpuprofile`, traceFilename]);
        const tracePath = await written.promise;
        expect(tracePath).toBe(session.createProfilePath(Number(index)).replace(/\.cpuprofile$/, ".trace.json"));
        expect(await fs.readFile(tracePath!, "utf8")).toBe('{"traceEvents":[]}');
      } finally {
        startWrite.resolve();
        registration.resolve();
        delivery.resolve();
      }
    },
  );

  it("captures a real main-thread burst that finishes before the trigger is evaluated", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "1000",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "8",
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      target: "main",
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.versions.node },
    });
    if (!sessionResult.ok) throw new Error(sessionResult.message);
    const written = deferred();
    const profiler = createProfiler({
      config,
      session: sessionResult.session,
      target: createMainProcessHotCpuTarget(),
      sampleNow: () => performance.now(),
      getAppMetrics: () => {
        const { user, system } = process.cpuUsage();
        return [{ ...createMetric(0, (user + system) / 1_000_000), pid: process.pid }];
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onProfileWritten: async () => { written.resolve(); },
    });
    await profiler.start();
    await samplesOf(profiler).waitForCount(1);
    // The inspector samples this synchronous function, but the timer cannot
    // evaluate the CPU trigger until the function has returned.
    function preTriggerCpuBurst(): void {
      const start = process.threadCpuUsage();
      let used = 0;
      while (used < 150_000) {
        for (let index = 0; index < 10_000; index += 1) Math.sqrt(Math.random());
        const elapsed = process.threadCpuUsage(start);
        used = elapsed.user + elapsed.system;
      }
    }
    preTriggerCpuBurst();
    await samplesOf(profiler).waitForCount(2);
    expect(profiler.hasActiveProfile).toBe(true);
    await written.promise;
    await profiler.stop();
    const profile = JSON.parse(await fs.readFile(sessionResult.session.createProfilePath(1), "utf8"));
    const burstIds = new Set(profile.nodes
      .filter((node: { callFrame: { functionName: string } }) => node.callFrame.functionName === "preTriggerCpuBurst")
      .map((node: { id: number }) => node.id));
    expect(burstIds.size).toBeGreaterThan(0);
    expect(profile.samples.some((id: number) => burstIds.has(id))).toBe(true);
  });

  it.each([
    { missingMetrics: false, delayedStop: false, suspendedMs: 0, timingErrorMs: 0, uncertaintyMs: 240 },
    { missingMetrics: true, delayedStop: true, suspendedMs: 0, timingErrorMs: 15, uncertaintyMs: 255 },
    { missingMetrics: false, delayedStop: false, suspendedMs: 1_000, timingErrorMs: undefined, uncertaintyMs: undefined },
  ])("times bounded history with missing metrics $missingMetrics, delayed stop $delayedStop and suspend $suspendedMs", async ({
    missingMetrics, delayedStop, suspendedMs, timingErrorMs, uncertaintyMs,
  }) => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_START_DELAY_MS: "0",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "30000",
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "1",
    });
    const sessionResult = await createHotCpuProfileSession({
      config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test" },
    });
    if (!sessionResult.ok) throw new Error(sessionResult.message);
    vi.useFakeTimers();
    const { target, debuggerApi } = createTarget();
    let recordingStart = 0;
    let windowIndex = 0;
    let elapsedDuringRotationMs = 0;
    const clockMs = () => Date.now() + elapsedDuringRotationMs;
    const fakePerformanceNow = performance.now.bind(performance);
    const appClock = vi.spyOn(performance, "now").mockImplementation(() => fakePerformanceNow() + elapsedDuringRotationMs);
    onTestFinished(() => { appClock.mockRestore(); });
    const frame = { functionName: "(root)", scriptId: "0", url: "", lineNumber: -1, columnNumber: -1 };
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Profiler.start") {
        // The new segment begins only after the old segment's stop/start gap.
        if (windowIndex > 0) elapsedDuringRotationMs += 240;
        recordingStart = clockMs() * 1_000;
        // The reply can arrive after V8 has already started recording.
        if (windowIndex > 0) elapsedDuringRotationMs += 100;
      }
      if (method !== "Profiler.stop") return {};
      const finalStop = windowIndex === 2;
      // V8 can stop after dispatch and reply later. Its clock can also omit
      // time the app's clock counted during system suspend.
      if (finalStop && delayedStop) elapsedDuringRotationMs += 70;
      const endTime = (clockMs() - (finalStop ? suspendedMs : 0)) * 1_000;
      if (finalStop && delayedStop) elapsedDuringRotationMs += 200;
      const name = ["expiredHistory", "burstBeforeRotation", "burstAfterRotation"][windowIndex++];
      return { profile: {
        nodes: [
          { id: 1, callFrame: frame, children: [2] },
          { id: 2, callFrame: { ...frame, functionName: name } },
        ],
        startTime: recordingStart,
        endTime,
        samples: [2],
        timeDeltas: [endTime - recordingStart],
      } };
    });
    let hot = false;
    let metricReads = 0;
    const written = deferred();
    const profiler = createProfiler({
      config,
      session: sessionResult.session,
      target,
      now: () => new Date(clockMs()),
      sampleNow: () => performance.now(),
      getAppMetrics: () => missingMetrics && ++metricReads < 3 ? [] : [{
        ...createMetric(0),
        cpu: { percentCPUUsage: hot ? 80 : 0, idleWakeupsPerSecond: 0 },
      } as ProcessMetric],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onProfileWritten: async () => { written.resolve(); },
    });
    await profiler.start();
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.start");
    await vi.advanceTimersByTimeAsync(0);
    await samplesOf(profiler).waitForCount(1);
    for (let count = 2; count <= 3; count += 1) {
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      await samplesOf(profiler).waitForCount(count);
    }
    expect(windowIndex).toBe(2);
    expect(await fs.readdir(sessionResult.session.directoryPath)).not.toContain("renderer-hot-0001.cpuprofile");
    hot = true;
    await vi.advanceTimersByTimeAsync(config.intervalMs);
    await samplesOf(profiler).waitForCount(4);
    // Detection happens before rotation: the still-running window is frozen
    // for the post-trigger duration, not discarded at the boundary.
    expect(windowIndex).toBe(2);
    await vi.advanceTimersByTimeAsync(config.profileDurationMs);
    await written.promise;
    await profiler.stop();
    const profile = JSON.parse(await fs.readFile(sessionResult.session.createProfilePath(1), "utf8"));
    const names = profile.nodes.map((node: { callFrame: { functionName: string } }) => node.callFrame.functionName);
    expect(names).toContain("burstBeforeRotation");
    expect(names).toContain("burstAfterRotation");
    expect(names).not.toContain("expiredHistory");
    expect(profile.endTime - profile.startTime).toBe((60_450 - suspendedMs + (delayedStop ? 70 : 0)) * 1_000);
    const events = (await fs.readFile(sessionResult.session.eventsPath, "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    const started = events.find((event) => event.type === "profile-started");
    const timing = events.find((event) => event.type === "profile-written").detail;
    expect(timing.triggeredAt).toBe(started.capturedAt);
    expect(timing.profileDurationMs).toBe((profile.endTime - profile.startTime) / 1_000);
    expect(timing.recordingStartUncertaintyMs).toBe(uncertaintyMs);
    if (timingErrorMs === undefined) {
      expect(timing.recordingStartedAt).toBeUndefined();
      expect(timing.preTriggerDurationMs).toBeUndefined();
    } else {
      expect(Date.parse(timing.recordingStartedAt)).toBe(Date.parse(started.capturedAt) - timing.preTriggerDurationMs);
      const actualPreTriggerMs = Date.parse(started.capturedAt) - profile.startTime / 1_000;
      expect(Math.abs(timing.preTriggerDurationMs - actualPreTriggerMs)).toBe(timingErrorMs);
    }
    expect(debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Profiler.start")).toHaveLength(3);
    expect(debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Profiler.stop")).toHaveLength(3);
    expect(target.debugger.isAttached()).toBe(false);
  });

  it("stops its CPU recorder without detaching a rendering lease", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path);
    const created = await createHotCpuProfileSession({
      config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test" },
    });
    if (!created.ok) throw new Error(created.message);
    const { target, debuggerApi } = createTarget();
    const profiler = createProfiler({
      config, session: created.session, target, getAppMetrics: () => [createMetric(0)],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await profiler.start();
    const trace = acquireDebuggerLease(debuggerApi, "Tracing");
    await profiler.stop("settings-disabled");
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    expect(debuggerApi.detach).not.toHaveBeenCalled();
    expect(trace.valid).toBe(true);
    trace.release();
    expect(debuggerApi.attach).toHaveBeenCalledOnce();
    expect(debuggerApi.detach).toHaveBeenCalledOnce();
  });

  it("discards an untriggered recorder and waits for an in-flight start during shutdown", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path);
    const sessionResult = await createHotCpuProfileSession({
      config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: "test" },
    });
    if (!sessionResult.ok) throw new Error(sessionResult.message);
    const { target, debuggerApi } = createTarget();
    const startEntered = deferred();
    const releaseStart = deferred();
    const sendCommand = debuggerApi.sendCommand.getMockImplementation()!;
    debuggerApi.sendCommand.mockImplementation(async (method: string) => {
      if (method === "Profiler.start") {
        startEntered.resolve();
        await releaseStart.promise;
      }
      return sendCommand(method);
    });
    const onProfileWritten = vi.fn();
    const profiler = createProfiler({
      config,
      session: sessionResult.session,
      target,
      getAppMetrics: () => [createMetric(0)],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onProfileWritten,
    });
    const started = profiler.start();
    await startEntered.promise;
    let stopped = false;
    const stopping = profiler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseStart.resolve();
    await Promise.all([started, stopping]);
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith("Profiler.stop");
    expect(target.debugger.isAttached()).toBe(false);
    expect(onProfileWritten).not.toHaveBeenCalled();
    expect((await fs.readdir(sessionResult.session.directoryPath)).filter((name) => name.endsWith(".cpuprofile"))).toEqual([]);
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
      createMetric(0, 0),
      createMetric(4, 0.00375),
      createMetric(4, 0.0075),
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
    await samplesOf(profiler).waitForCount(config.triggerMode === "spike" ? 2 : 3);
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
          cumulativeCpuDeltaSeconds: 0.00375,
          wallDeltaSeconds: 0.005,
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

    const { target, debuggerApi, detached } = createTarget();
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
      // Wait on the owned debugger boundary; waitFor advances fake timers
      // while profile writes await real I/O and can create an extra sample.
      await detached;
      expect(debuggerApi.detach).toHaveBeenCalled();

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

  it("resets rule evidence on edits and publishes one capture with the original matches", async () => {
    vi.useFakeTimers();
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const defaults = migrateHotCpuCaptureRules();
    const rules = { ...defaults, slowburn: { ...defaults.slowburn, enabled: true } };
    const config = (captureRules: typeof rules) => {
      const resolved = resolveHotCpuProfileConfig({ enabled: true, captureRules, env: {}, repoRoot: workspace.path });
      if (!resolved.enabled) throw new Error("Expected enabled capture");
      return resolved;
    };
    const initial = config(rules);
    const created = await createHotCpuProfileSession({
      config: initial,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
    });
    if (!created.ok) throw new Error(created.message);
    const { target } = createTarget();
    let cpu = 0;
    const report = vi.fn();
    const profiler = createProfiler({
      config: initial,
      getAppMetrics: () => [createMetric(0, cpu += 1.5)],
      session: created.session,
      target,
      onProfileWritten: report,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    await samplesOf(profiler).waitForCount(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await samplesOf(profiler).waitForCount(2);
    profiler.updateRules(config({ ...rules, sustained: { ...rules.sustained, thresholdPercent: 55 } }));
    for (let count = 3; count <= 5; count += 1) {
      await vi.advanceTimersByTimeAsync(2_000);
      await samplesOf(profiler).waitForCount(count);
      expect(profiler.hasActiveProfile).toBe(count === 5);
    }
    profiler.updateRules(config({ ...rules, highEnabled: false }));
    await vi.advanceTimersByTimeAsync(6_000);
    expect(profiler.hasActiveProfile).toBe(true);
    await profiler.stop();
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      triggerMode: "sustained",
      triggerThresholdPercent: 55,
      matchedRules: [
        { id: "sustained", thresholdPercent: 55, durationMs: 4_000, sampleCount: 2, intervalMs: 2_000,
          measuredDurationMs: 4_000, minimumCpuPercent: 75, peakCpuPercent: 75, triggerCpuPercent: 75, usedElectronInterval: false },
        { id: "slowburn", thresholdPercent: 15, durationMs: 4_000, sampleCount: 2, intervalMs: 2_000,
          measuredDurationMs: 4_000, minimumCpuPercent: 75, peakCpuPercent: 75, triggerCpuPercent: 75, usedElectronInterval: false },
      ],
    }));
    const events = (await fs.readFile(created.session.eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(events.filter((event) => event.type === "profile-started")).toHaveLength(1);
    expect(events.filter((event) => event.type === "profile-written")).toHaveLength(1);
  });

  it("captures with fallback metrics when another consumer reads during the sample interval", async () => {
    vi.useFakeTimers();
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "2000",
      PWRAGENT_HOT_CPU_PROFILING_TRIGGER_MODE: "spike",
    });
    const created = await createHotCpuProfileSession({
      config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
    });
    if (!created.ok) throw new Error(created.message);
    const { target } = createTarget();
    const getAppMetrics = createAppMetricsReader(() => [{
      ...createMetric(80),
      cpu: { percentCPUUsage: 80, idleWakeupsPerSecond: 0 },
    }], Date.now);
    const report = vi.fn();
    const profiler = createProfiler({
      config, getAppMetrics, session: created.session, target,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      onProfileWritten: report,
    });

    await profiler.start();
    await vi.advanceTimersByTimeAsync(0);
    await samplesOf(profiler).waitForCount(1);
    await vi.advanceTimersByTimeAsync(1_000);
    getAppMetrics();
    await vi.advanceTimersByTimeAsync(1_000);
    await samplesOf(profiler).waitForCount(2);
    expect(profiler.hasActiveProfile).toBe(true);
    await profiler.stop();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({
      matchedRules: [expect.objectContaining({
        triggerCpuPercent: 80, measuredDurationMs: 2_000, usedElectronInterval: true,
      })],
    }));
  });

  it("requires two observed hot intervals after a missing metric", async () => {
    const workspace = await createTemporaryTestDirectory();
    cleanups.push(workspace.cleanup);
    const config = createEnabledConfig(workspace.path, {
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "100",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "300",
    });
    const session = await createHotCpuProfileSession({
      config,
      versions: { appVersion: "test", electronVersion: "test", chromeVersion: "test", nodeVersion: process.version },
    });
    if (!session.ok) throw new Error(session.message);
    const { target } = createTarget();
    const observations = [
      [createMetric(0, 100)],
      [createMetric(95, 100.1)],
      [],
      [createMetric(95, 100.4)],
    ];
    let wallTime = 1_780_000_000_000;
    const profiler = createProfiler({
      config,
      getAppMetrics: () => { wallTime += 100; return observations.shift() ?? []; },
      session: session.session,
      target,
      now: () => new Date(wallTime),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await profiler.start();
    await samplesOf(profiler).waitForCount(4);
    expect(profiler.hasActiveProfile).toBe(false);
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
    await samplesOf(profiler).waitForCount(config.triggerMode === "spike" ? 2 : 3);
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
    await samplesOf(profiler).waitForCount(config.triggerMode === "spike" ? 2 : 3);
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
    const profileWritten = deferred();
    const onProfileWritten = vi.fn(() => profileWritten.resolve());
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

      // The stop snapshot follows real profile/artifact writes. Await their
      // completion signal instead of polling disk work on a one-second budget
      // (vi.waitFor also advances the fake profiler clock between polls).
      await profileWritten.promise;
      expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(3);
      expect(onHeapSnapshotLimitReached).toHaveBeenCalledTimes(1);
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

    await (profiler as unknown as {
      ensureRecording: (startedAtMs: number) => Promise<void>;
    }).ensureRecording(Date.now());
    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          capturedAtMonotonicMs: number;
          matches: HotCpuRuleMatch[];
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      capturedAtMonotonicMs: performance.now(),
      matches: config.rules.map((rule) => ({
        ...rule,
        intervalMs: config.intervalMs,
        measuredDurationMs: rule.durationMs,
        minimumCpuPercent: 89,
        peakCpuPercent: 89,
        triggerCpuPercent: 89,
        usedElectronInterval: false,
      })),
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

    await (profiler as unknown as {
      ensureRecording: (startedAtMs: number) => Promise<void>;
    }).ensureRecording(Date.now());
    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          capturedAtMonotonicMs: number;
          matches: HotCpuRuleMatch[];
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      capturedAtMonotonicMs: performance.now(),
      matches: config.rules.map((rule) => ({
        ...rule,
        intervalMs: config.intervalMs,
        measuredDurationMs: rule.durationMs,
        minimumCpuPercent: 89,
        peakCpuPercent: 89,
        triggerCpuPercent: 89,
        usedElectronInterval: false,
      })),
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

    await (profiler as unknown as {
      ensureRecording: (startedAtMs: number) => Promise<void>;
    }).ensureRecording(Date.now());
    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          capturedAtMonotonicMs: number;
          matches: HotCpuRuleMatch[];
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      capturedAtMonotonicMs: performance.now(),
      matches: config.rules.map((rule) => ({
        ...rule,
        intervalMs: config.intervalMs,
        measuredDurationMs: rule.durationMs,
        minimumCpuPercent: 89,
        peakCpuPercent: 89,
        triggerCpuPercent: 89,
        usedElectronInterval: false,
      })),
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

    await (profiler as unknown as {
      ensureRecording: (startedAtMs: number) => Promise<void>;
    }).ensureRecording(Date.now());
    await (
      profiler as unknown as {
        startProfile: (options: {
          capturedAt: string;
          capturedAtMonotonicMs: number;
          matches: HotCpuRuleMatch[];
          pid: number;
        }) => Promise<void>;
      }
    ).startProfile({
      capturedAt: new Date().toISOString(),
      capturedAtMonotonicMs: performance.now(),
      matches: config.rules.map((rule) => ({
        ...rule,
        intervalMs: config.intervalMs,
        measuredDurationMs: rule.durationMs,
        minimumCpuPercent: 89,
        peakCpuPercent: 89,
        triggerCpuPercent: 89,
        usedElectronInterval: false,
      })),
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
