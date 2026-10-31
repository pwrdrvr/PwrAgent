import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, type WebContents } from "electron";
import type { NativeCpuCaptureResult } from "../../shared/native-cpu-diagnostics";
import { acquireChromiumTrace } from "./chromium-trace-lease";
import { holdDebuggerConnection, requestDebuggerDetach } from "./debugger-connection-hold";
import { summarizeNativeCpuTrace } from "./native-cpu-trace";

export const NATIVE_CPU_DURATION_MS = 3_000;
export const NATIVE_CPU_DECODE_CAP = 64 * 1024 * 1024;
export const NATIVE_CPU_TRACE_CONFIG = {
  recordMode: "recordUntilFull", traceBufferSizeInKb: 8192, enableArgumentFilter: true,
  enableSampling: false, enableSystrace: false,
  includedCategories: ["toplevel", "devtools.timeline", "ipc", "mojom", "v8.execute"],
  excludedCategories: ["*"],
};
const TRANSFER_BUDGET_MS = 5_000;
const READ_BYTES = 1024 * 1024;
const failure = () => new Error("Native CPU capture failed; no summary is available");
type Target = Pick<WebContents, "debugger" | "getOSProcessId">;
type TraceComplete = { stream?: string; dataLossOccurred?: boolean };

function anchor() {
  return { wallTime: new Date().toISOString(), monotonicMs: performance.now(),
    monotonicOriginMs: performance.timeOrigin, hrtimeNs: process.hrtime.bigint().toString() };
}
function cpuSnapshot() {
  let all: ReturnType<typeof app.getAppMetrics> = [];
  let readFailed = false;
  try { all = app.getAppMetrics(); } catch { readFailed = true; }
  return { anchor: anchor(), readFailed, omittedProcesses: Math.max(0, all.length - 64),
    processes: all.slice(0, 64).map((m) => ({
      pid: m.pid, creationTime: m.creationTime,
      cumulativeCpuSeconds: Number.isFinite(m.cpu.cumulativeCPUUsage) ? m.cpu.cumulativeCPUUsage : null,
    })) };
}

class NativeCpuCapture {
  private attachedHere = false;
  private recording = false;
  private directory = "";
  private stream: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopTask: Promise<void> | undefined;
  private endRequested = false;
  private reason = "duration";
  private started = anchor();
  private stopRequested: ReturnType<typeof anchor> | undefined;
  private after: ReturnType<typeof cpuSnapshot> | undefined;
  private buffer = { peakFraction: 0, eventCount: 0, reports: 0 };
  private completeResolve!: (value: TraceComplete) => void;
  private readonly complete = new Promise<TraceComplete>((resolve) => { this.completeResolve = resolve; });
  private detached = false;
  private dataLossOccurred: boolean | null = null;
  private readonly message = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (method === "Tracing.bufferUsage") {
      this.buffer.reports++;
      if (typeof params.percentFull === "number" && Number.isFinite(params.percentFull)) {
        this.buffer.peakFraction = Math.max(this.buffer.peakFraction, params.percentFull);
      }
      if (typeof params.eventCount === "number" && Number.isFinite(params.eventCount)) {
        this.buffer.eventCount = Math.max(this.buffer.eventCount, params.eventCount);
      }
    }
    if (method === "Tracing.tracingComplete") {
      this.dataLossOccurred = typeof params.dataLossOccurred === "boolean" ? params.dataLossOccurred : null;
      // Capture the handle immediately so finally can close it even on failure.
      if (typeof params.stream === "string") this.stream = params.stream;
      this.completeResolve({ stream: this.stream });
    }
  };
  private readonly detach = () => {
    this.detached = true;
    this.completeResolve({});
  };
  readonly result: Promise<NativeCpuCaptureResult>;

  constructor(private readonly outputRoot: string, private readonly target: Target) {
    this.result = this.run();
  }

  stop(reason: "manual" | "shutdown" = "manual") {
    this.reason = reason;
    this.endRequested = true;
    if (this.recording) this.end();
    return this.result;
  }

  private end() {
    if (this.stopTask) return;
    this.endRequested = true;
    this.stopRequested = anchor();
    clearTimeout(this.timer);
    // Stop goes out before any awaited sampling or buffer/stream request.
    this.stopTask = this.target.debugger.sendCommand("Tracing.end").then(() => {});
    // A command rejection is observed here even while run() awaits start.
    void this.stopTask.catch(() => {});
    this.after = cpuSnapshot();
  }

  private async bounded<T>(task: Promise<T>, deadline: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(failure()), Math.max(0, deadline - performance.now()));
      })]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(): Promise<NativeCpuCaptureResult> {
    const d = this.target.debugger;
    let saved = false;
    const releaseConnection = holdDebuggerConnection(d);
    try {
      await mkdir(this.outputRoot, { recursive: true, mode: 0o700 });
      this.directory = await mkdtemp(join(this.outputRoot, "native-cpu-"));
      if (!d.isAttached()) { d.attach("1.3"); this.attachedHere = true; }
      d.on("message", this.message);
      d.on("detach", this.detach);
      const pid = this.target.getOSProcessId();
      if (!Number.isSafeInteger(pid) || pid <= 0) throw failure();
      const before = cpuSnapshot();
      this.started = anchor();
      this.timer = setTimeout(() => {
        this.endRequested = true;
        if (this.recording) this.end();
      }, NATIVE_CPU_DURATION_MS);
      // A rejected start never grants ownership, so never end another trace.
      await d.sendCommand("Tracing.start", {
        transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
        bufferUsageReportingInterval: 250,
        traceConfig: NATIVE_CPU_TRACE_CONFIG,
      });
      this.recording = true;
      const startAcknowledged = anchor();
      if (this.endRequested || performance.now() - this.started.monotonicMs >= NATIVE_CPU_DURATION_MS) this.end();
      // Completion may arrive before Tracing.end resolves.
      const complete = await this.bounded(this.complete, this.started.monotonicMs + NATIVE_CPU_DURATION_MS + TRANSFER_BUDGET_MS);
      if (this.detached || !complete.stream || !this.stopTask) throw failure();
      const transferDeadline = performance.now() + TRANSFER_BUDGET_MS;
      await this.bounded(this.stopTask, transferDeadline);
      this.recording = false;
      const chunks: Buffer[] = [];
      let bytes = 0, reads = 0;
      for (;;) {
        if (++reads > NATIVE_CPU_DECODE_CAP / READ_BYTES + 1) throw failure();
        const chunk = await this.bounded(d.sendCommand("IO.read", { handle: complete.stream, size: READ_BYTES }), transferDeadline);
        if (typeof chunk.data !== "string") throw failure();
        const data = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        bytes += data.length;
        if (bytes > NATIVE_CPU_DECODE_CAP) throw failure();
        chunks.push(data);
        if (chunk.eof) break;
      }
      await this.bounded(d.sendCommand("IO.close", { handle: complete.stream }), transferDeadline);
      this.stream = undefined;
      const trace = summarizeNativeCpuTrace(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const summaryPath = join(this.directory, "summary.json");
      const durationMs = this.stopRequested!.monotonicMs - this.started.monotonicMs;
      await writeFile(summaryPath, JSON.stringify({
        version: 1, platform: process.platform, electron: process.versions.electron,
        rendererPid: pid, mainPid: process.pid, reason: this.reason,
        requestedDurationMs: NATIVE_CPU_DURATION_MS, durationMs,
        deadlineOverrunMs: Math.max(0, durationMs - NATIVE_CPU_DURATION_MS),
        anchors: { startRequested: this.started, startAcknowledged, stopRequested: this.stopRequested, decoded: anchor() },
        traceClock: "Chromium trace microseconds; absolute alignment with main monotonic clock is not assumed",
        cpu: { before, after: this.after },
        buffer: { mode: "recordUntilFull", capacityBytes: 8192 * 1024, ...this.buffer,
          dataLossOccurred: this.dataLossOccurred, tailMayBeMissing: this.buffer.peakFraction >= 0.99 || this.dataLossOccurred !== false },
        transfer: { bytes, reads, decodeCapBytes: NATIVE_CPU_DECODE_CAP }, trace,
      }), { mode: 0o600, flag: "wx" });
      saved = true;
      return { summaryPath, durationMs };
    } catch {
      // Protocol/JSON errors may contain operator strings. Export a fixed error.
      throw failure();
    } finally {
      clearTimeout(this.timer);
      if (this.stream) {
        await this.bounded(d.sendCommand("IO.close", { handle: this.stream }), performance.now() + TRANSFER_BUDGET_MS).catch(() => {});
      }
      d.off("message", this.message);
      d.off("detach", this.detach);
      // Never detach a debugger owned by the V8 profiler or DevTools.
      if (this.attachedHere && d.isAttached()) requestDebuggerDetach(d);
      releaseConnection();
      if (!saved && this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
}

let active: NativeCpuCapture | undefined;
export async function captureNativeCpuDiagnostics(outputRoot: string, target: Target): Promise<NativeCpuCaptureResult> {
  if (active) throw new Error("A native CPU capture is already active");
  const releaseTrace = acquireChromiumTrace();
  const capture = new NativeCpuCapture(outputRoot, target);
  active = capture;
  try { return await capture.result; }
  finally {
    if (active === capture) active = undefined;
    releaseTrace();
  }
}
export async function stopNativeCpuDiagnostics(reason: "manual" | "shutdown" = "manual") {
  return active?.stop(reason);
}
