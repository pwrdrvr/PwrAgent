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

  afterEach(() => {
    vi.useRealTimers();
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
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report")).toHaveLength(3);
    expect(stackMessages).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.(event, report);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(2);

    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({ sender: { id: 18 } }, report);
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report stack")).toHaveLength(3);

    disposeRendererErrorIpcHandlers();
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
