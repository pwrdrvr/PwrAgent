import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
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

describe("RendererHotCpuProfiler", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
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
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    });

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
    const onProfileWritten = vi.fn(async () => {
      await profileWritten.promise;
    });
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(() => {
      expect(onProfileWritten).toHaveBeenCalledTimes(1);
    });

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
    const profiler = new RendererHotCpuProfiler({
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
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    });
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
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(() => {
      expect(debuggerApi.attach).toHaveBeenCalledWith("1.3");
    });
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

    const { target } = createTarget();
    const onHeapSnapshotLimitReached = vi.fn(async () => undefined);
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = new RendererHotCpuProfiler({
      config,
      getAppMetrics: () => [metrics.shift() ?? createMetric(0)],
      onHeapSnapshotLimitReached,
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

    await vi.waitFor(() => {
      expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(3);
    });
    await vi.waitFor(() => {
      expect(onHeapSnapshotLimitReached).toHaveBeenCalledTimes(1);
    });
    await profiler.stop("test-complete");

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
    const { target, debuggerApi } = createTarget();
    target.takeHeapSnapshot.mockImplementation(async () => {
      await startSnapshot.promise;
    });
    let nowCallCount = 0;
    const metrics = [
      createMetric(0, 100),
      createMetric(4, 101.5),
      createMetric(4, 103),
    ];
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(() => {
      expect(target.takeHeapSnapshot).toHaveBeenCalledTimes(1);
    });

    await profiler.stop("settings-disabled");
    startSnapshot.resolve();
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
    const profiler = new RendererHotCpuProfiler({
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
    await vi.waitFor(async () => {
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
    });

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
    const profiler = new RendererHotCpuProfiler({
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

    const profiler = new RendererHotCpuProfiler({
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
