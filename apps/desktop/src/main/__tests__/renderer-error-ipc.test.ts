import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    handlers.clear();
    errorLog.error.mockClear();
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

    await expect(handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, report)).resolves.toEqual({
      ok: true,
    });
    expect(errorLog.error).toHaveBeenCalledWith("report", {
      href: "http://localhost:5173/",
      message: "Should have a queue",
      name: "Error",
      source: "error-boundary",
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    });
    expect(errorLog.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(errorLog.error.mock.calls)).not.toContain("at App");

    disposeRendererErrorIpcHandlers();
    expect(handlers.has(RENDERER_ERROR_REPORT_CHANNEL)).toBe(false);
  });

  it("omits even large stacks while preserving the error message", async () => {
    const {
      registerRendererErrorIpcHandlers,
      disposeRendererErrorIpcHandlers,
    } = await import("../ipc/renderer-error");
    const { RENDERER_ERROR_REPORT_CHANNEL } = await import("../../shared/ipc");

    const stack = `Error: Deep stack${"\n    at frame".repeat(2000)}`;
    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, {
      href: "http://localhost:5173/",
      message: "Deep stack",
      source: "window-error",
      stack,
      timestamp: "2026-04-20T12:28:04.188Z",
      userAgent: "Vitest",
    });

    expect(errorLog.error).toHaveBeenCalledTimes(1);
    expect(errorLog.error).toHaveBeenCalledWith("report", expect.objectContaining({ message: "Deep stack" }));
    expect(JSON.stringify(errorLog.error.mock.calls)).not.toContain("at frame");

    disposeRendererErrorIpcHandlers();
  });

  it("logs repeated faults as messages without stacks", async () => {
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

    registerRendererErrorIpcHandlers();
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, report);
    await handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, report);

    const stackMessages = errorLog.error.mock.calls
      .map(([first]) => String(first))
      .filter((message) => message.startsWith("report stack"));
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report")).toHaveLength(3);
    expect(stackMessages).toHaveLength(0);

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
    await expect(handlers.get(RENDERER_ERROR_REPORT_CHANNEL)?.({}, {
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
});

