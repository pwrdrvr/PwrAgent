import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const debuggerApi = {
    attach: vi.fn(), isAttached: vi.fn(() => true), sendCommand: vi.fn(),
    on: vi.fn((event: string, callback: (...args: unknown[]) => void) => { listeners.set(event, callback); }),
    off: vi.fn((event: string) => { listeners.delete(event); }),
  };
  const session = { webContents: { debugger: debuggerApi }, isDestroyed: vi.fn(() => false), destroy: vi.fn() };
  return {
    listeners, debuggerApi, session,
    app: { getAppMetrics: vi.fn(() => []) },
    BrowserWindow: Object.assign(vi.fn(function () { return session; }), { getAllWindows: vi.fn(() => []) }),
    contentTracing: { startRecording: vi.fn(), stopRecording: vi.fn() },
  };
});
vi.mock("electron", () => electron);
import { captureRenderingDiagnostics, stopRenderingDiagnostics, summarizeRenderingTrace } from "../diagnostics/rendering-capture";
import { acquireChromiumTrace } from "../diagnostics/chromium-trace-lease";

let root: string;
const rawTrace = JSON.stringify({ traceEvents: [
  { name: "DrawFrame", ph: "X", pid: 21, ts: 1_000_000, args: { secret: "private-prompt" } },
  { name: "private-prompt", ph: "X", pid: 21, ts: 1_000_001 },
] });
function message(method: string, params: Record<string, unknown>) {
  electron.listeners.get("message")?.({}, method, params);
}
async function commands(method: string) {
  if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "owned-target" } };
  if (method === "Target.getTargets") return { targetInfos: [{ type: "page", targetId: "application-target" }] };
  if (method === "Tracing.end") {
    message("Tracing.bufferUsage", { percentFull: 0.2, eventCount: 12, secret: "private-prompt" });
    message("Tracing.tracingComplete", { stream: "owned-stream", dataLossOccurred: false });
  }
  if (method === "IO.read") return { data: rawTrace, eof: true };
  return {};
}
async function started() {
  await vi.waitFor(() => expect(electron.debuggerApi.sendCommand).toHaveBeenCalledWith("Tracing.start", expect.anything()));
}
beforeEach(async () => {
  vi.clearAllMocks();
  electron.listeners.clear();
  root = await mkdtemp(join(tmpdir(), "rendering-capture-"));
  electron.debuggerApi.sendCommand.mockImplementation(commands);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("opt-in rendering capture", () => {
  it("uses an owned session, exports only counters, and never writes a raw trace", async () => {
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
    const pending = captureRenderingDiagnostics(root, 30);
    await started();
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("already active");
    expect(await stopRenderingDiagnostics()).toEqual(await pending);
    const result = await pending;
    const text = await readFile(result.summaryPath, "utf8");
    expect(text).not.toContain("private-prompt");
    expect(text).not.toContain("args");
    expect(text).not.toContain("owned-stream");
    expect(JSON.parse(text).trace[0].events).toEqual([
      { name: "DrawFrame", count: 1, activeSeconds: [0] },
    ]);
    expect(await readdir(dirname(result.summaryPath))).toEqual(["summary.json"]);
    expect(electron.debuggerApi.sendCommand).toHaveBeenCalledWith("Tracing.start", expect.objectContaining({
      transferMode: "ReturnAsStream", traceConfig: expect.objectContaining({
        recordMode: "recordUntilFull", traceBufferSizeInKb: 8192, enableArgumentFilter: true,
      }),
    }));
    expect(electron.session.destroy).toHaveBeenCalledOnce();
    expect(electron.listeners.size).toBe(0);
    expect(await stopRenderingDiagnostics()).toBeUndefined();
    expect(electron.contentTracing.stopRecording).not.toHaveBeenCalled();
  });

  it("automatically stops without another renderer request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = captureRenderingDiagnostics(root, 1);
    await started();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).reason).toBe("duration");
    expect(electron.debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Tracing.end")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("admits existing and newly discovered pages without reattaching its own target", async () => {
    const pending = captureRenderingDiagnostics(root);
    await vi.waitFor(() => expect(electron.debuggerApi.sendCommand).toHaveBeenCalledWith("Target.setDiscoverTargets", { discover: true }));
    expect(electron.debuggerApi.sendCommand).toHaveBeenCalledWith("Target.attachToTarget", { targetId: "application-target", flatten: true });
    message("Target.targetCreated", { targetInfo: { type: "page", targetId: "owned-target" } });
    message("Target.targetCreated", { targetInfo: { type: "page", targetId: "new-page", title: "private-prompt" } });
    message("Target.targetCreated", { targetInfo: { type: "page", targetId: "new-page" } });
    expect(electron.debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(2);
    await stopRenderingDiagnostics();
    expect(await readFile((await pending).summaryPath, "utf8")).not.toContain("private-prompt");
  });

  it("rejects external CDP ownership without ending or adopting the external trace", async () => {
    electron.debuggerApi.sendCommand.mockRejectedValue(new Error("private-page-data"));
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Rendering capture failed; no summary is available");
    expect(electron.debuggerApi.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Tracing.start"]);
    expect(electron.contentTracing.startRecording).not.toHaveBeenCalled();
    expect(electron.contentTracing.stopRecording).not.toHaveBeenCalled();
    expect(electron.session.destroy).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
    const release = acquireChromiumTrace();
    release();
  });

  it("preserves the native CPU capture's shared lease and releases it after cleanup", async () => {
    const release = acquireChromiumTrace();
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Chromium diagnostics capture is already active");
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
    release();
    const pending = captureRenderingDiagnostics(root);
    await started();
    expect(() => acquireChromiumTrace()).toThrow("already active");
    await stopRenderingDiagnostics("shutdown");
    await pending;
    const nextRelease = acquireChromiumTrace();
    nextRelease();
  });

  it("stops once when shutdown arrives before the start acknowledgement", async () => {
    let acknowledge!: () => void;
    electron.debuggerApi.sendCommand.mockImplementation((method: string) => method === "Tracing.start"
      ? new Promise<void>((resolve) => { acknowledge = resolve; }) : commands(method));
    const pending = captureRenderingDiagnostics(root);
    await started();
    const stopped = stopRenderingDiagnostics("shutdown");
    const repeated = stopRenderingDiagnostics();
    expect(electron.debuggerApi.sendCommand).not.toHaveBeenCalledWith("Tracing.end");
    acknowledge();
    await Promise.all([pending, stopped, repeated]);
    expect(electron.debuggerApi.sendCommand.mock.calls.filter(([method]) => method === "Tracing.end")).toHaveLength(1);
  });

  it.each(["Tracing.start", "Tracing.end", "IO.read", "IO.close"])("bounds a hung %s and destroys only its own session", async (hung) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    electron.debuggerApi.sendCommand.mockImplementation((method: string) => method === hung
      ? new Promise(() => {}) : commands(method));
    const pending = captureRenderingDiagnostics(root, 1);
    const rejected = expect(pending).rejects.toThrow("Rendering capture failed");
    await started();
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(electron.session.destroy).toHaveBeenCalledOnce();
    expect(electron.listeners.size).toBe(0);
    expect(await readdir(root)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up detached sessions and malformed trace data with fixed errors", async () => {
    const pending = captureRenderingDiagnostics(root);
    const rejected = expect(pending).rejects.toThrow("Rendering capture failed");
    await started();
    electron.listeners.get("detach")?.();
    await rejected;
    expect(await readdir(root)).toEqual([]);
    electron.debuggerApi.sendCommand.mockImplementation((method: string) => method === "IO.read"
      ? Promise.resolve({ data: "private-invalid-json", eof: true }) : commands(method));
    const retry = captureRenderingDiagnostics(root);
    const retryRejected = expect(retry).rejects.toThrow("Rendering capture failed");
    await vi.waitFor(() => expect(electron.BrowserWindow).toHaveBeenCalledTimes(2));
    await stopRenderingDiagnostics().catch(() => {});
    await retryRejected;
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses invalid durations before allocating a session", async () => {
    for (const seconds of [NaN, Infinity, 0, 31, "10", null]) {
      await expect(captureRenderingDiagnostics(root, seconds)).rejects.toThrow("duration");
    }
    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it("separates activity by process and second, without counting span ends twice", () => {
    expect(summarizeRenderingTrace({ traceEvents: [
      { name: "process_name", ph: "M", pid: 1, ts: 0, args: { name: "private" } },
      { name: "DrawFrame", ph: "B", pid: 1, ts: 1_000_000 },
      { name: "DrawFrame", ph: "E", pid: 1, ts: 1_000_100 },
      { name: "DrawFrame", ph: "X", pid: 1, ts: 2_000_000 },
      { name: "Paint", ph: "X", pid: 2, ts: 2_000_000 },
    ] })).toEqual([
      { pid: 1, events: [{ name: "DrawFrame", count: 2, activeSeconds: [0, 1] }] },
      { pid: 2, events: [{ name: "Paint", count: 1, activeSeconds: [1] }] },
    ]);
  });
});
