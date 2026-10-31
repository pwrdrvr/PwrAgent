import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const metrics = vi.hoisted(() => vi.fn(() => [{ pid: 21, creationTime: 1, cpu: { cumulativeCPUUsage: 2 } }]));
vi.mock("electron", () => ({ app: { getAppMetrics: metrics } }));
import { captureNativeCpuDiagnostics, stopNativeCpuDiagnostics, NATIVE_CPU_TRACE_CONFIG } from "../diagnostics/native-cpu-capture";
import { requestDebuggerDetach } from "../diagnostics/debugger-connection-hold";
import { acquireChromiumTrace } from "../diagnostics/chromium-trace-lease";

class Debugger extends EventEmitter {
  attached = true;
  startedAt = 0;
  attach = vi.fn(() => { this.attached = true; });
  detach = vi.fn(() => { this.attached = false; this.emit("detach", {}, "test"); });
  isAttached = () => this.attached;
  data = JSON.stringify({ traceEvents: [
    { name: "Layout", cat: "devtools.timeline", ph: "X", pid: 21, tid: 22, ts: 1, dur: 4, args: { secret: "operator-content" } },
  ] });
  sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === "Tracing.start") this.startedAt = performance.now();
    if (method === "Tracing.end") this.emit("message", {}, "Tracing.tracingComplete", { stream: "private-handle", dataLossOccurred: false });
    if (method === "IO.read") return { data: this.data, eof: true };
    return {};
  });
}
let root: string;
let d: Debugger;
const target = () => ({ debugger: d as unknown as WebContents["debugger"], getOSProcessId: () => 21 });
const begin = async () => {
  const pending = captureNativeCpuDiagnostics(root, target());
  await vi.waitFor(() => expect(d.sendCommand).toHaveBeenCalledWith("Tracing.start", expect.any(Object)));
  return { pending };
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-cpu-test-"));
  d = new Debugger();
  metrics.mockClear();
  vi.useFakeTimers();
});
afterEach(async () => {
  await stopNativeCpuDiagnostics()?.catch(() => {});
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("bounded opt-in native CPU capture", () => {
  it("has zero off-state work and a two-snapshot active operation budget", async () => {
    await vi.advanceTimersByTimeAsync(86400_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(d.eventNames()).toEqual([]);
    expect(metrics).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
    const { pending } = await begin();
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(d.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Tracing.start", "Tracing.end", "IO.read", "IO.close"]);
    expect(metrics).toHaveBeenCalledTimes(2);
    expect(d.attach).not.toHaveBeenCalled();
    expect(d.detach).not.toHaveBeenCalled();
    expect(d.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    const text = await readFile(result.summaryPath, "utf8");
    expect(text).not.toContain("operator-content");
    expect(text).not.toContain("private-handle");
    const summary = JSON.parse(text);
    expect(summary.cpu.before.processes[0].cumulativeCpuSeconds).toBe(2);
    expect(summary.anchors.stopRequested.monotonicMs - summary.anchors.startRequested.monotonicMs).toBe(3000);
    expect(summary.buffer).toMatchObject({ capacityBytes: 8 * 1024 * 1024, dataLossOccurred: false, tailMayBeMissing: false });
    expect(await readdir(dirname(result.summaryPath))).toEqual(["summary.json"]);
    if (process.platform !== "win32") {
      expect((await stat(result.summaryPath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(result.summaryPath))).mode & 0o777).toBe(0o700);
    }
  });

  it("requests stop at the fixed main deadline without a renderer callback or buffer query", async () => {
    const { pending } = await begin();
    await vi.advanceTimersByTimeAsync(2999 - (performance.now() - d.startedAt));
    expect(d.sendCommand.mock.calls.map(([m]) => m)).toEqual(["Tracing.start"]);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(d.sendCommand.mock.calls[1][0]).toBe("Tracing.end");
    expect(d.sendCommand.mock.calls[0][1]).toMatchObject({ traceConfig: NATIVE_CPU_TRACE_CONFIG });
  });

  it("defers the V8 owner's detach until native stream cleanup, without sending Profiler commands", async () => {
    const { pending } = await begin();
    requestDebuggerDetach(d);
    expect(d.detach).not.toHaveBeenCalled();
    const stopping = stopNativeCpuDiagnostics("shutdown");
    expect(await pending).toEqual(await stopping);
    expect(d.detach).toHaveBeenCalledOnce();
    expect(d.sendCommand.mock.calls.some(([m]) => m.startsWith("Profiler."))).toBe(false);
    expect(d.sendCommand.mock.invocationCallOrder.at(-1)).toBeLessThan(d.detach.mock.invocationCallOrder[0]);
  });

  it("releases a debugger it attached itself and marks saturation/loss", async () => {
    d.attached = false;
    const { pending } = await begin();
    d.emit("message", {}, "Tracing.bufferUsage", { percentFull: 1, eventCount: 99, private: "operator-content" });
    await stopNativeCpuDiagnostics();
    const result = await pending;
    expect(d.attach).toHaveBeenCalledOnce();
    expect(d.detach).toHaveBeenCalledOnce();
    const summary = JSON.parse(await readFile(result.summaryPath, "utf8"));
    expect(summary.buffer).toMatchObject({ peakFraction: 1, tailMayBeMissing: true, reports: 1 });
    expect(summary.trace.coverage.overwritten).toBe(false);
  });

  it("rejects local overlap and preserves an external trace when CDP rejects start", async () => {
    const release = acquireChromiumTrace();
    await expect(captureNativeCpuDiagnostics(root, target())).rejects.toThrow("already active");
    release();
    d.sendCommand.mockRejectedValue(new Error("private-operator-path"));
    await expect(captureNativeCpuDiagnostics(root, target())).rejects.toThrow("Native CPU capture failed");
    expect(d.sendCommand.mock.calls.map(([m]) => m)).toEqual(["Tracing.start"]);
    expect(d.detach).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["bad-json", "read-failed", "decode-cap", "non-progress"])("closes raw streams and leaves no files on %s", async (fault) => {
    const normal = d.sendCommand.getMockImplementation()!;
    let reads = 0;
    d.sendCommand.mockImplementation(async (method, params) => {
      if (method === "IO.read") {
        reads++;
        if (fault === "bad-json") return { data: "operator-content", eof: true };
        if (fault === "read-failed") throw new Error("operator-content");
        if (fault === "decode-cap") return { data: " ".repeat(1024 * 1024), eof: false };
        return { data: "", eof: false };
      }
      return normal(method, params);
    });
    const { pending } = await begin();
    const rejected = expect(pending).rejects.toThrow("Native CPU capture failed");
    await stopNativeCpuDiagnostics()?.catch(() => {});
    await rejected;
    expect(reads).toBeLessThanOrEqual(65);
    expect(d.sendCommand).toHaveBeenCalledWith("IO.close", { handle: "private-handle" });
    expect(await readdir(root)).toEqual([]);
    expect(d.detach).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles target destruction without publishing partial attribution", async () => {
    const { pending } = await begin();
    const rejected = expect(pending).rejects.toThrow("Native CPU capture failed");
    d.emit("detach", {}, "target-closed");
    await rejected;
    expect(await readdir(root)).toEqual([]);
    expect(d.detach).not.toHaveBeenCalled();
  });
});
