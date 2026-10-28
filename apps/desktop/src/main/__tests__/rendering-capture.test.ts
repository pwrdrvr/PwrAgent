import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { getAppMetrics: vi.fn(() => []) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  contentTracing: {
    startRecording: vi.fn(async () => {}),
    stopRecording: vi.fn(async (_path: string) => {}),
    getTraceBufferUsage: vi.fn(async () => ({ percentFull: 0.1, value: 12 })),
  },
}));
vi.mock("electron", () => electron);
import { captureRenderingDiagnostics, stopRenderingDiagnostics, summarizeRenderingTrace } from "../diagnostics/rendering-capture";

let root: string;
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "rendering-capture-"));
  electron.contentTracing.startRecording.mockResolvedValue();
  electron.contentTracing.stopRecording.mockImplementation(async (path) => {
    await writeFile(path, JSON.stringify({ traceEvents: [
      { name: "DrawFrame", ph: "X", pid: 21, ts: 1_000_000, args: { secret: "private-prompt" } },
      { name: "private-prompt", ph: "X", pid: 21, ts: 1_000_001 },
    ] }));
  });
});
afterEach(async () => {
  await stopRenderingDiagnostics();
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("opt-in rendering capture", () => {
  it("does no recording until requested, exports only counters, and deletes the raw trace", async () => {
    expect(electron.contentTracing.startRecording).not.toHaveBeenCalled();
    const pending = captureRenderingDiagnostics(root, 30);
    await vi.waitFor(() => expect(electron.contentTracing.startRecording).toHaveBeenCalledOnce());
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("already active");
    const stopped = await stopRenderingDiagnostics();
    const result = await pending;
    expect(stopped).toEqual(result);
    const text = await readFile(result.summaryPath, "utf8");
    expect(text).not.toContain("private-prompt");
    expect(text).not.toContain("args");
    expect(JSON.parse(text).trace[0].events).toEqual([
      { name: "DrawFrame", count: 1, activeSeconds: [0] },
    ]);
    expect(await readdir(dirname(result.summaryPath))).toEqual(["summary.json"]);
    expect(electron.contentTracing.startRecording.mock.calls[0]).toMatchObject([{
      recording_mode: "record-until-full", trace_buffer_size_in_kb: 8192, enable_argument_filter: true,
    }]);
    expect(await stopRenderingDiagnostics()).toBeUndefined();
  });

  it("automatically stops even when the requesting renderer does nothing further", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = captureRenderingDiagnostics(root, 1);
    await vi.waitFor(() => expect(electron.contentTracing.startRecording).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).reason).toBe("duration");
    expect(electron.contentTracing.stopRecording).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses invalid durations and leaves an existing Chromium recorder alone", async () => {
    for (const seconds of [NaN, Infinity, 0, 31, "10", null]) {
      await expect(captureRenderingDiagnostics(root, seconds)).rejects.toThrow("duration");
    }
    electron.contentTracing.startRecording.mockRejectedValue(new Error("private-path"));
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Rendering capture failed");
    expect(electron.contentTracing.stopRecording).not.toHaveBeenCalled();
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
