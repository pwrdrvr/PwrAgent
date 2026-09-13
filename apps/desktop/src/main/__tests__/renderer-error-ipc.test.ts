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
    // The compact field formatter caps a structured value at 320 characters;
    // the stacks carry the only frames that identify the faulty code, so they
    // are logged verbatim as their own messages.
    expect(errorLog.error).toHaveBeenCalledWith(
      "report stack\nError: Should have a queue",
    );
    expect(errorLog.error).toHaveBeenCalledWith("report component stack\nat App");

    disposeRendererErrorIpcHandlers();
    expect(handlers.has(RENDERER_ERROR_REPORT_CHANNEL)).toBe(false);
  });

  it("bounds a stack that exceeds the log limit", async () => {
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

    const logged = errorLog.error.mock.calls
      .map(([first]) => String(first))
      .find((message) => message.startsWith("report stack"));
    // The first 8000 characters, then a suffix naming what was dropped so a
    // truncated frame is never read as the last frame.
    expect(logged).toBe(
      `report stack\n${stack.slice(0, 8000)}… (${stack.length - 8000} more characters)`,
    );

    disposeRendererErrorIpcHandlers();
  });

  it("logs a repeated fault's stack once per window", async () => {
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
    // Every report still logs its summary; only the identical stack is dropped,
    // because re-logging it adds no signal and rotates the 1 MB main log.
    expect(errorLog.error.mock.calls.filter(([first]) => first === "report")).toHaveLength(3);
    expect(stackMessages).toHaveLength(1);

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

