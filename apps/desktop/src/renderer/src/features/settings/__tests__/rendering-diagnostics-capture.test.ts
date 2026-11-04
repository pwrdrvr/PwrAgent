import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRenderingDiagnosticsCapture } from "../rendering-diagnostics-capture";

describe("Settings rendering capture", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does no idle work and cancels staging without calling the API", async () => {
    const capture = createRenderingDiagnosticsCapture();
    const api = { captureRenderingDiagnostics: vi.fn() };
    const listener = vi.fn();
    const unsubscribe = capture.subscribe(listener);
    expect(vi.getTimerCount()).toBe(0);
    expect(capture.getSnapshot()).toEqual({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.captureRenderingDiagnostics).not.toHaveBeenCalled();
    capture.start(api);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(api.captureRenderingDiagnostics).not.toHaveBeenCalled();
    capture.cancel();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.captureRenderingDiagnostics).not.toHaveBeenCalled();
    expect(capture.getSnapshot()).toEqual({ phase: "idle" });
    unsubscribe();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives leaving Settings, prevents duplicate starts, and retains the result", async () => {
    const capture = createRenderingDiagnosticsCapture();
    const result = { summaryPath: "/fixture/state/diagnostics/rendering-test/summary.json", durationMs: 10_005 };
    let resolve!: (value: typeof result) => void;
    const api = {
      captureRenderingDiagnostics: vi.fn(() => new Promise<typeof result>((done) => { resolve = done; })),
    };
    const notice = vi.fn();
    const unsubscribe = capture.subscribe(vi.fn());
    capture.start(api, notice);
    capture.start(api, notice);
    unsubscribe(); // The pane unmounts while staging.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.captureRenderingDiagnostics).toHaveBeenCalledExactlyOnceWith(10);
    expect(capture.getSnapshot()).toEqual({ phase: "capturing" });
    capture.start(api, notice);
    capture.cancel(); // Cancellation must not stop an active native trace.
    expect(api.captureRenderingDiagnostics).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0); // No renderer deadline, countdown or polling.
    resolve(result);
    await vi.advanceTimersByTimeAsync(0);
    expect(capture.getSnapshot()).toEqual({ phase: "complete", result });
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({
      title: "Rendering summary saved", copyText: result.summaryPath, autoDismiss: false,
    }));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports API failures and permits an explicit retry", async () => {
    const capture = createRenderingDiagnosticsCapture();
    const result = { summaryPath: "/fixture/summary.json", durationMs: 10_000 };
    const api = { captureRenderingDiagnostics: vi.fn()
      .mockRejectedValueOnce(new Error("A rendering capture is already active"))
      .mockResolvedValueOnce(result) };
    const notice = vi.fn();
    capture.start(api, notice);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture.getSnapshot()).toEqual({ phase: "error", error: "A rendering capture is already active" });
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ title: "Rendering capture failed", tone: "error" }));
    capture.start(api, notice);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(capture.getSnapshot()).toEqual({ phase: "complete", result });
    expect(api.captureRenderingDiagnostics).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not arm a timer when the API is unavailable", () => {
    const capture = createRenderingDiagnosticsCapture();
    capture.start({});
    expect(capture.getSnapshot()).toEqual({ phase: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
