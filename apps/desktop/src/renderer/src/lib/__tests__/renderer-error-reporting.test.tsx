import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalRendererErrorHandlers } from "../renderer-error-reporting";
import { recordRendererUpdate, RendererUpdateEvent } from "../renderer-update-diagnostics";
import type { RendererUpdateSnapshot } from "../../../../shared/renderer-update-diagnostics";

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("renderer error reporting", () => {
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
