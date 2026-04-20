import { afterEach, describe, expect, it, vi } from "vitest";
import { installGlobalRendererErrorHandlers } from "../renderer-error-reporting";

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as Window & { pwragnt?: unknown }).pwragnt;
});

describe("renderer error reporting", () => {
  it("forwards uncaught window errors to the desktop bridge", async () => {
    const reportRendererError = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        reportRendererError,
      },
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const uninstall = installGlobalRendererErrorHandlers();
    window.dispatchEvent(
      new ErrorEvent("error", {
        colno: 7,
        error: new Error("global render failure"),
        filename: "renderer.js",
        lineno: 42,
      }),
    );
    uninstall();

    await expect(reportRendererError).toHaveBeenCalledWith(
      expect.objectContaining({
        colno: 7,
        filename: "renderer.js",
        lineno: 42,
        message: "global render failure",
        source: "window-error",
      }),
    );
  });
});

