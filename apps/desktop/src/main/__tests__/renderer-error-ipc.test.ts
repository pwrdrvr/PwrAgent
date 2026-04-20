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
    expect(errorLog.error).toHaveBeenCalledWith("report", report);

    disposeRendererErrorIpcHandlers();
    expect(handlers.has(RENDERER_ERROR_REPORT_CHANNEL)).toBe(false);
  });
});

