import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RendererErrorReport } from "../../shared/renderer-error";

const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const errorLog = {
  error: vi.fn(),
};

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => errorLog),
}));

describe("renderer error ipc", () => {
  const event = { sender: { id: 17 } };

  beforeEach(() => {
    handlers.clear();
    errorLog.error.mockClear();
  });

  afterEach(async () => {
    const { disposeRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    disposeRendererErrorIpcHandlers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("logs structured renderer error reports in the main process", async () => {
    const {
      registerRendererErrorIpcHandlers,
      disposeRendererErrorIpcHandlers,
    } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const report: RendererErrorReport = {
      componentStack: "at App",
      href: "http://localhost:5173/",
      message: "Should have a queue",
      name: "Error",
      source: "error-boundary",
      stack: "Error: Should have a queue",
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    };

    registerRendererErrorIpcHandlers();

    await expect(handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report)).resolves.toEqual({
      ok: true,
    });
    expect(errorLog.error).toHaveBeenCalledWith("report", expect.objectContaining({
      href: "http://localhost:5173/",
      message: "Should have a queue",
      name: "Error",
      source: "error-boundary",
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    }));
    expect(errorLog.error).toHaveBeenCalledWith("report stack", expect.any(Object), report.stack);
    expect(errorLog.error).toHaveBeenCalledWith("report component stack", expect.any(Object), report.componentStack);
    expect(errorLog.error).toHaveBeenCalledTimes(3);

    disposeRendererErrorIpcHandlers();
    expect(handlers.has(RENDERER_ERROR_REPORT_CHANNEL)).toBe(false);
  });

  it("logs update history separately, bounded and deduplicated even without a stack", async () => {
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    const report = {
      href: "file:///renderer/index.html", message: "Maximum update depth exceeded",
      source: "error-boundary", timestamp: "2026-10-04T16:33:11Z", userAgent: "Vitest",
      updateDiagnostics: {
        version: 1, capacity: 64, capturedAtMs: 200, total: 1000,
        counts: Array.from({ length: 10000 }, () => 1000),
        events: Array.from({ length: 10000 }, (_, index) => ({
          event: index % 11, scope: "r".repeat(32),
          firstMs: Number.MAX_SAFE_INTEGER, lastMs: Number.MAX_SAFE_INTEGER, count: Number.MAX_SAFE_INTEGER,
          draft: "private draft must never reach the log",
        })),
      },
    };
    vi.useFakeTimers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    const logs = errorLog.error.mock.calls.filter(([first]) => first === "report update diagnostics");
    expect(logs).toHaveLength(1);
    const serialized = logs[0][2] as string;
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);
    expect(serialized).not.toContain("private draft");
    const snapshot = JSON.parse(serialized);
    expect(snapshot.events.length).toBeLessThanOrEqual(64);
    expect(snapshot.omittedEvents).toBeGreaterThan(10000 - 64);
    expect(snapshot.events.at(-1).event).toBe(9999 % 11);
    expect(snapshot.counts).toHaveLength(11);
    expect(snapshot.eventNames).toContain("tooltipHide");
    expect(errorLog.error.mock.calls.find(([first]) => first === "report")?.[1])
      .not.toHaveProperty("updateDiagnostics");
    vi.advanceTimersByTime(60_000);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report update diagnostics")).toHaveLength(2);
  });

  it("ignores malformed update history while preserving the error report", async () => {
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    await expect(handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, {
      href: "file:///renderer/index.html", message: "Fault with malformed history", source: "window-error",
      updateDiagnostics: { version: 1, events: "invalid", counts: [] },
    })).resolves.toEqual({ ok: true });
    expect(errorLog.error.mock.calls.map(([first]) => first)).toEqual(["report"]);
    expect(errorLog.error.mock.calls[0][1]).not.toHaveProperty("updateDiagnostics");
  });

  it("bounds large stacks while retaining useful frames and an explicit truncation marker", async () => {
    const {
      registerRendererErrorIpcHandlers,
      disposeRendererErrorIpcHandlers,
    } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");

    const stack = `Error: Deep stack${"\n    at frame".repeat(2000)}`;
    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, {
      href: "http://localhost:5173/",
      message: "Deep stack",
      source: "window-error",
      stack,
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    });

    expect(errorLog.error).toHaveBeenCalledTimes(2);
    expect(errorLog.error).toHaveBeenCalledWith("report", expect.objectContaining({ message: "Deep stack" }));
    const loggedStack = errorLog.error.mock.calls.find(([first]) => first === "report stack")?.[2];
    expect(loggedStack).toContain("Error: Deep stack\n    at frame");
    expect(loggedStack).toContain("[stack truncated]");
    expect(loggedStack.length).toBeLessThanOrEqual(16 * 1024);

    disposeRendererErrorIpcHandlers();
  });

  it("keeps repeated faults visible while suppressing identical stacks for one minute", async () => {
    const {
      registerRendererErrorIpcHandlers,
      disposeRendererErrorIpcHandlers,
    } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const report: RendererErrorReport = {
      href: "http://localhost:5173/",
      message: "Repeating rejection",
      source: "unhandled-rejection",
      stack: "Error: Repeating rejection\n    at poll",
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    };

    vi.useFakeTimers();
    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);

    const stackMessages = errorLog.error.mock.calls
      .map(([first]) => String(first))
      .filter((message) => message.startsWith("report stack"));
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report")).toHaveLength(1);
    expect(stackMessages).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    expect(errorLog.error).toHaveBeenCalledWith("report repeats", expect.objectContaining({
      repeat: expect.objectContaining({ count: 2 }),
    }));
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(2);

    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({ sender: { id: 18 } }, report);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(3);

    disposeRendererErrorIpcHandlers();
  });

  it("bounds raw IPC bursts including summaries and diagnostics serialization", async () => {
    vi.useFakeTimers();
    const { registerRendererErrorIpcHandlers, disposeRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const serialization = vi.spyOn(JSON, "stringify");
    const events = vi.fn(() => []);
    const report = {
      href: "http://localhost:5173/#star-map",
      message: "ResizeObserver loop completed with undelivered notifications.",
      source: "window-error", timestamp: new Date().toISOString(), userAgent: "Vitest",
      updateDiagnostics: { version: 1, counts: [], get events() { return events(); } },
    };
    registerRendererErrorIpcHandlers();
    for (let index = 0; index < 1000; index += 1) {
      await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    }
    const diagnosticSerializations = serialization.mock.calls.filter(([input]) => input?.eventNames).length;
    console.info("raw IPC burst work", { loggerCalls: errorLog.error.mock.calls.length, diagnosticSerializations });
    expect(diagnosticSerializations).toBe(1);
    expect(errorLog.error.mock.calls.map(([first]) => first)).toEqual(["report", "report update diagnostics"]);
    expect(events).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(errorLog.error).toHaveBeenCalledTimes(3);
    expect(errorLog.error).toHaveBeenLastCalledWith("report repeats", expect.objectContaining({
      repeat: expect.objectContaining({ count: 999 }),
    }));
    expect(vi.getTimerCount()).toBe(0);
    disposeRendererErrorIpcHandlers();
  });

  it("never suppresses explicit automatic, stopped or manual recovery reports", async () => {
    vi.useFakeTimers();
    const { registerRendererErrorIpcHandlers, disposeRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    for (const action of ["automatic-remount", "automatic-remount", "stopped", "manual-remount"]) {
      await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, {
        href: "file:///renderer/index.html", message: "persistent fault", source: "error-boundary",
        timestamp: new Date().toISOString(), userAgent: "Vitest", stack: "Error: persistent fault",
        recovery: { action, attempt: 2, limit: 2 },
      });
    }
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report")).toHaveLength(4);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    disposeRendererErrorIpcHandlers();
  });

  it("links renderer repeat batches without delaying the next minute's failure snapshot", async () => {
    vi.useFakeTimers();
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    const first = {
      faultId: "a".repeat(32), href: "http://localhost:5173/#star-map", source: "window-error",
      message: "m".repeat(2048), timestamp: new Date().toISOString(), userAgent: "Vitest",
      updateDiagnostics: { version: 1, counts: [], events: [], total: 1 },
    };
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, first);
    vi.advanceTimersByTime(60_000);
    const batch = {
      ...first, message: first.message.slice(0, 1024), updateDiagnostics: undefined,
      repeat: { count: 999, firstTimestamp: first.timestamp, lastTimestamp: new Date().toISOString() },
    };
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, batch);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, { ...first,
      updateDiagnostics: { ...first.updateDiagnostics, total: 1001 },
    });
    const reports = errorLog.error.mock.calls.filter(([name]) => name === "report" || name === "report repeats");
    expect(reports).toHaveLength(3);
    expect(new Set(reports.map(([, report]) => report.stackId)).size).toBe(1);
    expect(errorLog.error.mock.calls.filter(([name]) => name === "report update diagnostics")).toHaveLength(2);
    // Even a caller resending aggregated batches is bounded in main.
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, batch);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, batch);
    expect(errorLog.error).toHaveBeenCalledTimes(5);
    vi.advanceTimersByTime(60_000);
    expect(errorLog.error).toHaveBeenLastCalledWith("report repeats", expect.objectContaining({
      repeat: expect.objectContaining({ count: 1998 }),
    }));
  });

  it("admits a new renderer window and its diagnostics when IPC latency decreases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    const first = {
      faultId: "a".repeat(32), reportingWindowId: "00000000-0000-4000-8000-000000000001",
      href: "http://localhost:5173/#star-map", source: "window-error", message: "same fault",
      timestamp: new Date().toISOString(), userAgent: "Vitest",
      updateDiagnostics: { version: 1, counts: [], events: [], total: 1 },
    };
    // Capture at t=0, deliver at t=1s. A duplicate of this window stays bounded.
    vi.advanceTimersByTime(1000);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, first);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, first);
    vi.advanceTimersByTime(59_000);
    const next = { ...first, reportingWindowId: "00000000-0000-4000-8000-000000000002",
      timestamp: new Date().toISOString(), updateDiagnostics: { ...first.updateDiagnostics, total: 1001 } };
    // The next renderer window has zero latency: only 59s have elapsed in main.
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, next);
    const summaries = errorLog.error.mock.calls.filter(([name]) => name === "report");
    expect(summaries).toHaveLength(2);
    expect(summaries[0][1].stackId).toBe(summaries[1][1].stackId);
    const details = errorLog.error.mock.calls.filter(([name]) => name === "report update diagnostics");
    expect(details).toHaveLength(2);
    expect(details.map(([, , serialized]) => JSON.parse(serialized).total)).toEqual([1, 1001]);
    // Resending the new window cannot repeatedly capture or log its details.
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, next);
    expect(errorLog.error.mock.calls.filter(([name]) => name === "report")).toHaveLength(2);
    expect(errorLog.error.mock.calls.filter(([name]) => name === "report update diagnostics")).toHaveLength(2);
  });

  it("merges delayed repeat batches using their occurrence range rather than receipt time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(120_000);
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    registerRendererErrorIpcHandlers();
    const report = {
      faultId: "a".repeat(32), href: "http://localhost:5173/#star-map", source: "window-error",
      message: "same fault", timestamp: new Date().toISOString(), userAgent: "Vitest",
      repeat: { count: 1, firstTimestamp: new Date(0).toISOString(), lastTimestamp: new Date(1000).toISOString() },
    };
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    vi.advanceTimersByTime(1000);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, { ...report,
      repeat: { count: 3, firstTimestamp: new Date(10_000).toISOString(), lastTimestamp: new Date(20_000).toISOString() },
    });
    vi.advanceTimersByTime(1000);
    // An out-of-order teardown batch widens both ends of the occurrence range.
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, { ...report,
      repeat: { count: 4, firstTimestamp: new Date(5000).toISOString(), lastTimestamp: new Date(25_000).toISOString() },
    });
    vi.advanceTimersByTime(58_000);
    expect(errorLog.error).toHaveBeenLastCalledWith("report repeats", expect.objectContaining({
      timestamp: new Date(25_000).toISOString(),
      repeat: { count: 7, firstTimestamp: new Date(5000).toISOString(), lastTimestamp: new Date(25_000).toISOString() },
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not throw away a report whose stack is not a string", async () => {
    const {
      registerRendererErrorIpcHandlers,
      disposeRendererErrorIpcHandlers,
    } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");

    registerRendererErrorIpcHandlers();
    // The channel is not a type system: a renderer whose `Error.prepareStackTrace`
    // was replaced can report a structured stack, and losing the whole report to
    // a TypeError is worse than losing the stack.
    await expect(handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, {
      componentStack: "   ",
      href: "http://localhost:5173/",
      message: "Structured stack",
      source: "window-error",
      stack: { frames: [] },
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    })).resolves.toEqual({ ok: true });

    expect(errorLog.error.mock.calls.map(([first]) => String(first)))
      .toEqual(["report"]);

    disposeRendererErrorIpcHandlers();
  });

  it("bounds the remembered fault identities without suppressing new stacks", async () => {
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const report = (frame: number): RendererErrorReport => ({
      href: "http://localhost:5173/",
      message: "Repeated fault",
      source: "unhandled-rejection",
      stack: `Error: Repeated fault\n    at frame${frame}`,
      timestamp: "2026-10-03T01:16:59.045Z",
      userAgent: "Vitest",
    });
    registerRendererErrorIpcHandlers();
    for (let frame = 0; frame < 65; frame += 1) {
      await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report(frame));
    }
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report(64));
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(65);

    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report(0));
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(66);
  });

  it("logs different faults even when their component stacks are identical", async () => {
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const report: RendererErrorReport = {
      href: "http://localhost:5173/",
      message: "First fault",
      source: "error-boundary",
      componentStack: "at ComposerErrorRail",
      timestamp: "2026-10-03T01:16:59.045Z",
      userAgent: "Vitest",
    };
    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, { ...report, message: "Second fault" });

    expect(errorLog.error.mock.calls.filter(([first]) => first === "report component stack")).toHaveLength(2);
  });

  it("preserves full multiline stack frames through the real compact log formatter", async () => {
    const { registerRendererErrorIpcHandlers } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");
    const { compactStructuredLogData, formatAppLogLine } = await vi.importActual<typeof import("../log")>("../log");
    const stack = `Error: Maximum update depth exceeded\n${Array.from({ length: 20 }, (_, index) =>
      `    at frame${index} (file:///Applications/PwrAgent.app/Contents/Resources/app.asar/out/renderer/assets/ThreadView.js:6:${index + 1})`
    ).join("\n")}`;
    const componentStack = "\n    at ComposerErrorRail (ThreadView.js:6:133)\n    at Composer (ThreadView.js:9:16879)";
    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, {
      href: "file:///Applications/PwrAgent.app/Contents/Resources/app.asar/out/renderer/index.html",
      message: "Maximum update depth exceeded",
      source: "error-boundary",
      stack,
      componentStack,
      timestamp: "2026-10-03T01:16:59.045Z",
      userAgent: "Vitest",
    });

    const lines = errorLog.error.mock.calls.map((data) => formatAppLogLine({
      data: compactStructuredLogData(data), date: new Date(), level: "error",
    })).join("\n");
    expect(lines).toContain(stack);
    expect(lines).toContain(componentStack.trim());
    const summary = errorLog.error.mock.calls.find(([first]) => first === "report")?.[1];
    expect(summary.stackId).toMatch(/^[a-f0-9]{16}$/);
    expect(errorLog.error.mock.calls.filter(([first]) => first !== "report").map(([, context]) => context))
      .toEqual([
        { webContentsId: event.sender.id, stackId: summary.stackId },
        { webContentsId: event.sender.id, stackId: summary.stackId },
      ]);
  });
});
