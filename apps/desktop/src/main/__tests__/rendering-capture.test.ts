import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: { getAppMetrics: vi.fn(() => []) },
  BrowserWindow: { getAllWindows: vi.fn((): BrowserWindow[] => []) },
}));
vi.mock("electron", () => electron);
import { captureRenderingDiagnostics, stopRenderingDiagnostics, summarizeRenderingTrace } from "../diagnostics/rendering-capture";
import { acquireDebuggerLease } from "../diagnostics/debugger-lease";

function createTarget() {
  let attached = false;
  let destroyed = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    attach: vi.fn((_version: string) => { attached = true; }),
    detach: vi.fn(() => { attached = false; debuggerApi.emit("detach", {}, "test"); }),
    isAttached: vi.fn(() => attached),
    sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
      if (method === "Tracing.end") debuggerApi.emit("message", {}, "Tracing.tracingComplete", { stream: "owned" });
      if (method === "IO.read") return { data: JSON.stringify({ traceEvents: [
        { name: "DrawFrame", ph: "X", pid: 21, ts: 1_000_000, args: { secret: "private-prompt" } },
        { name: "private-prompt", ph: "X", pid: 21, ts: 1_000_001 },
      ] }), eof: true };
      return {};
    }),
  });
  const contents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    id: 1,
    isDestroyed: () => destroyed,
    isDevToolsOpened: vi.fn(() => false),
    getOSProcessId: () => 21,
    executeJavaScript: vi.fn(async () => null),
  });
  const window = {
    id: 1, webContents: contents, isDestroyed: () => destroyed,
    isVisible: () => true, isMinimized: () => false, isFocused: () => true,
  } as unknown as BrowserWindow;
  return { debuggerApi, contents, window, destroy() {
    destroyed = true;
    debuggerApi.detach();
    contents.emit("destroyed");
  } };
}

let root: string;
let target: ReturnType<typeof createTarget>;
const startCalled = () => vi.waitFor(() => expect(target.debuggerApi.sendCommand)
  .toHaveBeenCalledWith("Tracing.start", expect.any(Object)));
const calls = (method: string) => target.debuggerApi.sendCommand.mock.calls.filter(([name]) => name === method);
beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "rendering-capture-"));
  target = createTarget();
  electron.BrowserWindow.getAllWindows.mockReturnValue([target.window]);
});
afterEach(async () => {
  await stopRenderingDiagnostics()?.catch(() => {});
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe("opt-in rendering capture", () => {
  it("does no recording until requested, exports only counters, and deletes the private raw trace", async () => {
    expect(target.debuggerApi.attach).not.toHaveBeenCalled();
    const pending = captureRenderingDiagnostics(root, 30);
    await startCalled();
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
    expect(calls("Tracing.start")[0][1]).toMatchObject({
      transferMode: "ReturnAsStream",
      traceConfig: { recordMode: "recordUntilFull", traceBufferSizeInKb: 8192, enableArgumentFilter: true },
    });
    expect(calls("Tracing.end")).toHaveLength(1);
    expect(calls("IO.close")[0][1]).toEqual({ handle: "owned" });
    expect(target.debuggerApi.isAttached()).toBe(false);
    expect(target.debuggerApi.listenerCount("message")).toBe(0);
    expect(await stopRenderingDiagnostics()).toBeUndefined();
  });

  it("automatically stops even when the requesting renderer does nothing further", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = captureRenderingDiagnostics(root, 1);
    await startCalled();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(JSON.parse(await readFile(result.summaryPath, "utf8")).reason).toBe("duration");
    expect(calls("Tracing.end")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("refuses invalid durations and never ends a trace after CDP acquisition fails", async () => {
    for (const seconds of [NaN, Infinity, 0, 31, "10", null]) {
      await expect(captureRenderingDiagnostics(root, seconds)).rejects.toThrow("duration");
    }
    target.debuggerApi.sendCommand.mockRejectedValue(new Error("private-path"));
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Rendering capture failed");
    expect(calls("Tracing.end")).toHaveLength(0);
    expect(target.debuggerApi.isAttached()).toBe(false);
  });

  it.each(["unknown attachment", "DevTools"])("leaves %s alone", async (owner) => {
    if (owner === "DevTools") target.contents.isDevToolsOpened.mockReturnValue(true);
    else target.debuggerApi.attach("1.3");
    target.debuggerApi.attach.mockClear();
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Rendering capture failed");
    expect(target.debuggerApi.attach).not.toHaveBeenCalled();
    expect(target.debuggerApi.detach).not.toHaveBeenCalled();
    expect(target.debuggerApi.sendCommand).not.toHaveBeenCalled();
  });

  it.each(["manual", "shutdown"] as const)("waits for acquisition during %s and ends exactly once", async (reason) => {
    let acquired!: () => void;
    const start = new Promise<void>((resolve) => { acquired = resolve; });
    const send = target.debuggerApi.sendCommand.getMockImplementation()!;
    target.debuggerApi.sendCommand.mockImplementation((method, params) => method === "Tracing.start" ? start : send(method, params));
    const pending = captureRenderingDiagnostics(root, 30);
    await startCalled();
    const stopping = stopRenderingDiagnostics(reason);
    const again = stopRenderingDiagnostics(reason);
    expect(calls("Tracing.end")).toHaveLength(0);
    acquired();
    await Promise.all([pending, stopping, again]);
    expect(calls("Tracing.end")).toHaveLength(1);
    expect(target.debuggerApi.isAttached()).toBe(false);
  });

  it("does not detach the CPU owner's connection, even when acquisition fails", async () => {
    const cpu = acquireDebuggerLease(target.debuggerApi, "Profiler");
    target.debuggerApi.sendCommand.mockRejectedValueOnce(new Error("trace-conflict"));
    await expect(captureRenderingDiagnostics(root)).rejects.toThrow("Rendering capture failed");
    expect(cpu.valid).toBe(true);
    expect(target.debuggerApi.detach).not.toHaveBeenCalled();
    target.debuggerApi.sendCommand.mockRestore();
    cpu.release();
    expect(target.debuggerApi.detach).toHaveBeenCalledOnce();
  });

  it.each(["destroyed", "replaced"])("releases a %s target without stopping a replacement trace", async (loss) => {
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    if (loss === "destroyed") target.destroy();
    else {
      target.debuggerApi.detach();
      target.debuggerApi.attach("1.3");
    }
    await failed;
    expect(calls("Tracing.end")).toHaveLength(0);
    expect(target.debuggerApi.detach).toHaveBeenCalledOnce();
    expect(target.debuggerApi.listenerCount("message")).toBe(0);
  });

  it("closes the stream and removes partial raw data on a read failure", async () => {
    const send = target.debuggerApi.sendCommand.getMockImplementation()!;
    let reads = 0;
    target.debuggerApi.sendCommand.mockImplementation(async (method, params) => {
      if (method === "IO.read") {
        if (reads++) throw new Error("private-stream-error");
        return { data: "private-partial", eof: false };
      }
      return send(method, params);
    });
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    await stopRenderingDiagnostics().catch(() => {});
    await failed;
    expect(calls("IO.close")).toHaveLength(1);
    expect(calls("Tracing.end")).toHaveLength(1);
    const directories = await readdir(root);
    expect(await readdir(join(root, directories[0]))).toEqual([]);
  });

  it("does not retry a failed end command or detach a surviving CPU owner", async () => {
    const cpu = acquireDebuggerLease(target.debuggerApi, "Profiler");
    const send = target.debuggerApi.sendCommand.getMockImplementation()!;
    target.debuggerApi.sendCommand.mockImplementation(async (method, params) => {
      if (method === "Tracing.end") throw new Error("private-end-error");
      return send(method, params);
    });
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    await stopRenderingDiagnostics().catch(() => {});
    await failed;
    expect(calls("Tracing.end")).toHaveLength(1);
    expect(target.debuggerApi.detach).not.toHaveBeenCalled();
    expect(cpu.valid).toBe(true);
    cpu.release();
  });

  it("rejects a stream expansion above 64 MiB and deletes it", async () => {
    const send = target.debuggerApi.sendCommand.getMockImplementation()!;
    target.debuggerApi.sendCommand.mockImplementation(async (method, params) => {
      if (method === "IO.read") return { data: "x".repeat(1024 * 1024), eof: false };
      return send(method, params);
    });
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    await stopRenderingDiagnostics().catch(() => {});
    await failed;
    expect(calls("IO.read")).toHaveLength(65);
    expect(calls("IO.close")).toHaveLength(1);
    const directories = await readdir(root);
    expect(await readdir(join(root, directories[0]))).toEqual([]);
  });

  it("cleans up when the target disappears before start acknowledges", async () => {
    let acquired!: () => void;
    target.debuggerApi.sendCommand.mockImplementation(() => new Promise<void>((resolve) => { acquired = resolve; }));
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    target.destroy();
    acquired();
    await failed;
    expect(calls("Tracing.end")).toHaveLength(0);
    expect(target.debuggerApi.detach).toHaveBeenCalledOnce();
  });

  it("reports a sanitized failure if the native stream cannot be closed", async () => {
    const cpu = acquireDebuggerLease(target.debuggerApi, "Profiler");
    const send = target.debuggerApi.sendCommand.getMockImplementation()!;
    target.debuggerApi.sendCommand.mockImplementation(async (method, params) => {
      if (method === "IO.close") throw new Error("private-native-path");
      return send(method, params);
    });
    const pending = captureRenderingDiagnostics(root, 30);
    const failed = expect(pending).rejects.toThrow("Rendering capture failed");
    await startCalled();
    await stopRenderingDiagnostics().catch(() => {});
    await failed;
    const directories = await readdir(root);
    expect(await readdir(join(root, directories[0]))).toEqual([]);
    expect(cpu.valid).toBe(true);
    cpu.release();
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
