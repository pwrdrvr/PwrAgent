import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalRendererErrorHandlers } from "../renderer-error-reporting";
import { recordRendererUpdate, RendererUpdateEvent } from "../renderer-update-diagnostics";
import type { RendererErrorReport } from "../../../../shared/renderer-error";
import type { RendererUpdateSnapshot } from "../../../../shared/renderer-update-diagnostics";
import * as diagnostics from "../renderer-update-diagnostics";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("renderer error reporting", () => {
  it("identifies admitted windows across timer expiry and handler reinstallation", () => {
    vi.useFakeTimers();
    const bridge = vi.fn(async (_report: RendererErrorReport) => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError: bridge } });
    const uninstall = installGlobalRendererErrorHandlers();
    const fail = (): void => { window.dispatchEvent(new ErrorEvent("error", { message: "same fault" })); };
    fail();
    fail();
    vi.advanceTimersByTime(60_000);
    fail();
    uninstall();
    const uninstallReplacement = installGlobalRendererErrorHandlers();
    fail();
    uninstallReplacement();
    const reports = bridge.mock.calls.map(([report]) => report);
    expect(reports).toHaveLength(4);
    const windows = reports.map((report) => report.reportingWindowId);
    expect(windows[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(windows[1]).toBe(windows[0]);
    expect(new Set([windows[0], windows[2], windows[3]]).size).toBe(3);
    expect(new Set(reports.map((report) => report.faultId)).size).toBe(1);
  });

  it("flushes pending counts on document teardown without capturing again", () => {
    vi.useFakeTimers();
    const bridge = vi.fn(async (_report: RendererErrorReport) => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError: bridge } });
    const capture = vi.spyOn(diagnostics, "snapshotRendererUpdates");
    const uninstall = installGlobalRendererErrorHandlers();
    window.dispatchEvent(new ErrorEvent("error", { message: "teardown burst" }));
    window.dispatchEvent(new ErrorEvent("error", { message: "teardown burst" }));
    window.dispatchEvent(new Event("pagehide"));
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenLastCalledWith(expect.objectContaining({ repeat: expect.objectContaining({ count: 1 }) }));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    uninstall();
    expect(bridge).toHaveBeenCalledTimes(2);
  });

  it("bounds a 1000-error burst before capture and IPC, retaining the first failure", () => {
    vi.useFakeTimers();
    const bridge = vi.fn(async (_report: RendererErrorReport) => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError: bridge } });
    const capture = vi.spyOn(diagnostics, "snapshotRendererUpdates");
    const retain = vi.spyOn(diagnostics, "retainRendererUpdateFailure");
    const uninstall = installGlobalRendererErrorHandlers();
    for (let index = 0; index < 1000; index += 1) {
      window.dispatchEvent(new ErrorEvent("error", {
        message: "ResizeObserver loop completed with undelivered notifications.",
      }));
      recordRendererUpdate(RendererUpdateEvent.tooltipHide);
    }
    console.info("renderer burst work", { bridgeCalls: bridge.mock.calls.length,
      captures: capture.mock.calls.length, retainedCopies: retain.mock.calls.length });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge).toHaveBeenLastCalledWith(expect.objectContaining({
      repeat: expect.objectContaining({ count: 999 }),
      faultId: bridge.mock.calls[0][0].faultId,
    }));
    expect(bridge.mock.calls[1][0]).not.toHaveProperty("updateDiagnostics");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    uninstall();
  });

  it("preserves distinct locations, sources and stacks, flushing pending counts on uninstall", () => {
    vi.useFakeTimers();
    const bridge = vi.fn(async (_report: RendererErrorReport) => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError: bridge } });
    const uninstall = installGlobalRendererErrorHandlers();
    const error = new Error("same message");
    window.dispatchEvent(new ErrorEvent("error", { error, lineno: 1 }));
    window.dispatchEvent(new ErrorEvent("error", { error, lineno: 1 }));
    window.dispatchEvent(new ErrorEvent("error", { error, lineno: 2 }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: error });
    window.dispatchEvent(rejection);
    const otherStack = new Error("same message");
    otherStack.stack = "different stack";
    window.dispatchEvent(new ErrorEvent("error", { error: otherStack, lineno: 1 }));
    expect(bridge).toHaveBeenCalledTimes(4);
    uninstall();
    expect(bridge).toHaveBeenCalledTimes(5);
    expect(bridge).toHaveBeenLastCalledWith(expect.objectContaining({ repeat: expect.objectContaining({ count: 1 }) }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("distinguishes faults beyond the bounded summary prefix without retaining large keys", () => {
    const bridge = vi.fn(async (_report: RendererErrorReport) => ({ ok: true }));
    Object.defineProperty(window, "pwragent", { configurable: true, value: { reportRendererError: bridge } });
    const uninstall = installGlobalRendererErrorHandlers();
    for (const suffix of ["one", "two"]) {
      window.dispatchEvent(new ErrorEvent("error", { message: "x".repeat(20_000) + suffix }));
    }
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge.mock.calls[0][0].faultId).toHaveLength(32);
    expect(bridge.mock.calls[1][0].faultId).not.toEqual(bridge.mock.calls[0][0].faultId);
    uninstall();
  });

  it("forwards uncaught window errors to the desktop bridge", async () => {
    const reportRendererError = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragent", {
      configurable: true,
      value: {
        reportRendererError,
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const uninstall = installGlobalRendererErrorHandlers();
    const view = (window as unknown as { __pwragentRendererUpdates: {
      snapshot: () => RendererUpdateSnapshot;
      lastError: () => RendererUpdateSnapshot | undefined;
      eventNames: readonly string[];
    } }).__pwragentRendererUpdates;
    recordRendererUpdate(RendererUpdateEvent.editorPublish);
    expect(reportRendererError).not.toHaveBeenCalled();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.eventNames)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(window, "__pwragentRendererUpdates")?.writable).toBe(false);
    window.dispatchEvent(
      new ErrorEvent("error", {
        colno: 7,
        error: new Error("global render failure"),
        filename: "renderer.js",
        lineno: 42,
      }),
    );
    const captured = view.lastError();
    expect(captured?.events.at(-1)?.event).toBe(RendererUpdateEvent.editorPublish);
    recordRendererUpdate(RendererUpdateEvent.tooltipHide);
    expect(view.lastError()).toEqual(captured);
    expect(view.snapshot().events.at(-1)?.event).toBe(RendererUpdateEvent.tooltipHide);
    uninstall();
    expect(window).not.toHaveProperty("__pwragentRendererUpdates");

    await expect(reportRendererError).toHaveBeenCalledWith(
      expect.objectContaining({
        colno: 7,
        filename: "renderer.js",
        lineno: 42,
        message: "global render failure",
        source: "window-error",
        updateDiagnostics: expect.objectContaining({ capacity: 64 }),
      }),
    );
  });
});
