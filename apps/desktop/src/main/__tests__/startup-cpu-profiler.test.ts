import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StartupCpuProfileSession } from "../diagnostics/startup-cpu-profile-session";

vi.mock("electron", () => ({
  app: {
    getAppPath: vi.fn(() => "/repo/apps/desktop"),
    getVersion: vi.fn(() => "0.1.0"),
  },
}));

type Handler = (...args: unknown[]) => void;

function createEnabledConfig() {
  return {
    enabled: true as const,
    repoRoot: "/repo",
    outputRoot: "/repo/.local",
    postLoadDurationMs: 5000,
    hardTimeoutMs: 15000,
  };
}

function createSession(): StartupCpuProfileSession {
  return {
    id: "abc123",
    directoryName: "startup-cpu-2026-04-19-0930-abc123",
    directoryPath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123",
    manifestPath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/session.json",
    eventsPath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/events.ndjson",
    mainProfilePath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/main.cpuprofile",
    rendererProfilePath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/renderer.cpuprofile",
    analysisPath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/analysis.json",
    summaryPath: "/repo/.local/startup-cpu-2026-04-19-0930-abc123/summary.md",
    appendEvent: vi.fn(async () => undefined),
    markProfileCaptured: vi.fn(async () => undefined),
    markAnalysisGenerated: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  };
}

function createWindowTarget() {
  const windowHandlers = new Map<string, Handler[]>();
  const webContentsHandlers = new Map<string, Handler[]>();

  return {
    window: {
      on: vi.fn((event: string, handler: Handler) => {
        const handlers = windowHandlers.get(event) ?? [];
        handlers.push(handler);
        windowHandlers.set(event, handlers);
      }),
      webContents: {
        on: vi.fn((event: string, handler: Handler) => {
          const handlers = webContentsHandlers.get(event) ?? [];
          handlers.push(handler);
          webContentsHandlers.set(event, handlers);
        }),
      },
    },
    emitWindow(event: string, ...args: unknown[]) {
      for (const handler of windowHandlers.get(event) ?? []) {
        handler(...args);
      }
    },
    emitWebContents(event: string, ...args: unknown[]) {
      for (const handler of webContentsHandlers.get(event) ?? []) {
        handler(...args);
      }
    },
  };
}

describe("StartupCpuProfiler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("captures both profilers and analyzes the session after the startup window", async () => {
    const session = createSession();
    const createSessionMock = vi.fn(async () => ({
      ok: true as const,
      session,
    }));
    const mainProfiler = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => true),
    };
    const rendererProfiler = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => true),
    };
    const createMainProfiler = vi.fn(() => mainProfiler);
    const createRendererProfiler = vi.fn(() => rendererProfiler);
    const analyzeSession = vi.fn(async () => ({ ok: true }));
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const { window, emitWebContents } = createWindowTarget();
    const now = vi.fn(() => new Date("2026-04-19T13:30:00.000Z"));

    const { StartupCpuProfiler } = await import("../diagnostics/startup-cpu-profiler");
    const profiler = new StartupCpuProfiler({
      config: createEnabledConfig(),
      logger,
      now,
      createSession: createSessionMock,
      createMainProfiler,
      createRendererProfiler,
      analyzeSession,
    });

    await profiler.start();
    profiler.attachWindow(window as never);
    emitWebContents("did-finish-load");
    await vi.advanceTimersByTimeAsync(5000);

    expect(createSessionMock).toHaveBeenCalledTimes(1);
    expect(mainProfiler.start).toHaveBeenCalledTimes(1);
    expect(rendererProfiler.start).toHaveBeenCalledTimes(1);
    expect(mainProfiler.stop).toHaveBeenCalledWith("startup-window-complete");
    expect(rendererProfiler.stop).toHaveBeenCalledWith("startup-window-complete");
    expect(analyzeSession).toHaveBeenCalledWith({
      sessionDirectoryPath: session.directoryPath,
      repoRoot: "/repo",
      analysisPath: session.analysisPath,
      summaryPath: session.summaryPath,
    });
    expect(session.markAnalysisGenerated).toHaveBeenCalledWith("2026-04-19T13:30:00.000Z");
    expect(session.complete).toHaveBeenCalledWith({
      status: "completed",
      completedAt: "2026-04-19T13:30:00.000Z",
    });
    expect(session.appendEvent).toHaveBeenCalledWith({
      source: "main",
      capturedAt: "2026-04-19T13:30:00.000Z",
      type: "controller-started",
      detail: {
        sessionDirectory: session.directoryPath,
      },
    });
    expect(session.appendEvent).toHaveBeenCalledWith({
      source: "main",
      capturedAt: "2026-04-19T13:30:00.000Z",
      type: "controller-stopped",
      detail: {
        reason: "startup-window-complete",
        status: "completed",
      },
    });
  });

  it("stops on the hard timeout and skips analysis when no profiles were captured", async () => {
    const session = createSession();
    const mainProfiler = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => false),
    };
    const rendererProfiler = {
      start: vi.fn(async () => true),
      stop: vi.fn(async () => false),
    };
    const analyzeSession = vi.fn(async () => ({ ok: true }));
    const { window } = createWindowTarget();

    const { StartupCpuProfiler } = await import("../diagnostics/startup-cpu-profiler");
    const profiler = new StartupCpuProfiler({
      config: {
        ...createEnabledConfig(),
        hardTimeoutMs: 25,
      },
      now: () => new Date("2026-04-19T13:30:00.000Z"),
      createSession: vi.fn(async () => ({
        ok: true as const,
        session,
      })),
      createMainProfiler: vi.fn(() => mainProfiler),
      createRendererProfiler: vi.fn(() => rendererProfiler),
      analyzeSession,
    });

    await profiler.start();
    profiler.attachWindow(window as never);
    await vi.advanceTimersByTimeAsync(25);

    expect(mainProfiler.stop).toHaveBeenCalledWith("hard-timeout");
    expect(rendererProfiler.stop).toHaveBeenCalledWith("hard-timeout");
    expect(analyzeSession).not.toHaveBeenCalled();
    expect(session.complete).toHaveBeenCalledWith({
      status: "failed",
      completedAt: "2026-04-19T13:30:00.000Z",
    });
  });
});
