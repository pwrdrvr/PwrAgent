import fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTemporaryTestDirectory } from "@pwragent/agent-core";
import type { ProcessMetric } from "electron";
import { resolveHotCpuProfileConfig } from "../diagnostics/hot-cpu-profile-config";
import { createHotCpuProfileSession } from "../diagnostics/hot-cpu-profile-session";
import { RendererHotCpuProfiler } from "../diagnostics/renderer-hot-cpu-profiler";

function createEnabledConfig(repoRoot: string) {
  const config = resolveHotCpuProfileConfig({
    env: {
      PWRAGENT_HOT_CPU_PROFILING: "1",
      PWRAGENT_HOT_CPU_PROFILING_INTERVAL_MS: "5",
      PWRAGENT_HOT_CPU_PROFILING_THRESHOLD_PERCENT: "50",
      PWRAGENT_HOT_CPU_PROFILING_CONSECUTIVE_SAMPLES: "2",
      PWRAGENT_HOT_CPU_PROFILING_DURATION_MS: "10",
      PWRAGENT_HOT_CPU_PROFILING_COOLDOWN_MS: "20",
      PWRAGENT_HOT_CPU_PROFILING_MAX_PROFILES: "2",
    },
    repoRoot,
  });

  expect(config.enabled).toBe(true);
  if (!config.enabled) {
    throw new Error("Expected hot CPU profiling to be enabled.");
  }

  return config;
}

function createMetric(percentCPUUsage: number): ProcessMetric {
  return {
    pid: 1234,
    type: "Tab",
    serviceName: "Tab",
    name: "PwrAgent Renderer",
    cpu: {
      percentCPUUsage,
      cumulativeCPUUsage: 42,
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
      takeHeapSnapshot: vi.fn(async () => undefined),
    },
    debuggerApi,
    setDestroyed: (value: boolean) => {
      destroyed = value;
    },
  };
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
    const metrics = [createMetric(0), createMetric(72), createMetric(89)];
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
      now: () => new Date(),
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
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "profile-started" }),
        expect.objectContaining({ type: "profile-written" }),
      ]),
    );
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
    const profiler = new RendererHotCpuProfiler({
      config,
      getAppMetrics: () => [createMetric(95)],
      session: sessionResult.session,
      target,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
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
