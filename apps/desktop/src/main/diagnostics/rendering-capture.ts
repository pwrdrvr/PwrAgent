import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { readRenderingSnapshot, type RenderingCaptureResult } from "../../shared/rendering-diagnostics";
import { acquireChromiumTrace } from "./chromium-trace-lease";
import { RENDERER_UPDATE_EVENT_NAMES } from "../../shared/renderer-update-diagnostics";

// No screenshots, JS stacks, user timing, URLs, DOM or trace arguments are exported.
export const RENDERING_TRACE_CONFIG: Electron.TraceConfig = {
  recording_mode: "record-until-full",
  trace_buffer_size_in_kb: 8192,
  enable_argument_filter: true,
  included_categories: ["cc", "viz", "gpu", "devtools.timeline", "disabled-by-default-devtools.timeline.frame"],
  excluded_categories: ["*"],
};

const EVENTS = [
  "BeginFrame", "BeginMainThreadFrame", "DrawFrame", "SubmitCompositorFrame",
  "Display::DrawAndSwap", "PipelineReporter", "Paint", "Layout", "UpdateLayoutTree",
  "FireAnimationFrame", "RequestAnimationFrame", "TimerFire", "FunctionCall",
];

/** Export counts and one-second activity buckets, never untrusted trace strings/args. */
export function summarizeRenderingTrace(trace: { traceEvents?: Record<string, unknown>[] }) {
  const processes = new Map<number, Map<string, { count: number; seconds: Set<number> }>>();
  let origin = Infinity;
  for (const event of trace.traceEvents ?? []) {
    if (typeof event.ts === "number" && event.ph !== "M") origin = Math.min(origin, event.ts);
  }
  for (const event of trace.traceEvents ?? []) {
    if (!EVENTS.includes(event.name as string) || !["X", "B", "I", "i", "b"].includes(event.ph as string)
      || typeof event.pid !== "number" || typeof event.ts !== "number") continue;
    let process = processes.get(event.pid);
    if (!process) processes.set(event.pid, process = new Map());
    const name = event.name as string;
    let counter = process.get(name);
    if (!counter) process.set(name, counter = { count: 0, seconds: new Set() });
    counter.count += 1;
    counter.seconds.add(Math.floor((event.ts - origin) / 1_000_000));
  }
  return [...processes].map(([pid, events]) => ({
    pid,
    events: [...events].map(([name, value]) => ({
      name, count: value.count, activeSeconds: [...value.seconds].sort((a, b) => a - b),
    })),
  }));
}

async function sampleWindows(ownedWindow: BrowserWindow) {
  const windows = BrowserWindow.getAllWindows().filter((window) => window !== ownedWindow);
  return {
    // Electron CPU is not a GPU utilization counter. Numeric PID joins identify the GPU helper.
    processes: app.getAppMetrics().slice(0, 64).map((metric) => ({
      pid: metric.pid, type: metric.type, cpuPercent: metric.cpu.percentCPUUsage,
    })),
    omittedWindows: Math.max(0, windows.length - 16),
    windows: await Promise.all(windows.slice(0, 16).map(async (window) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return null;
      const identity = {
        windowId: window.id, webContentsId: window.webContents.id,
        pid: window.webContents.getOSProcessId(),
        visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(),
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const renderer = await Promise.race([
          window.webContents.executeJavaScript(`(${readRenderingSnapshot.toString()})()`),
          new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 750); }),
        ]);
        return { ...identity, renderer };
      } catch {
        return { ...identity, renderer: null };
      } finally {
        clearTimeout(timer);
      }
    })),
  };
}

const TRANSFER_BUDGET_MS = 5_000;
const DECODE_CAP = 64 * 1024 * 1024;
const READ_BYTES = 1024 * 1024;
const failure = () => new Error("Rendering capture failed; no summary is available");

class RenderingCapture {
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopTimer: ReturnType<typeof setTimeout> | undefined;
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  private samples: { atMs: number; state: Awaited<ReturnType<typeof sampleWindows>> }[] = [];
  private sampleTask: Promise<void> | undefined;
  private directory = "";
  private session: BrowserWindow | undefined;
  private debuggerApi: Electron.Debugger | undefined;
  private recording = false;
  private endRequested = false;
  private endTask: Promise<unknown> | undefined;
  private reason: "duration" | "manual" | "shutdown" = "duration";
  private stoppedAt = 0;
  private stream: string | undefined;
  private closed = false;
  private bufferUsage = { percentage: 0, value: 0 };
  private dataLossOccurred: boolean | null = null;
  private completeResolve!: (stream: string | undefined) => void;
  private readonly complete = new Promise<string | undefined>((resolve) => { this.completeResolve = resolve; });
  readonly result: Promise<RenderingCaptureResult>;

  constructor(outputRoot: string, seconds: number) {
    this.result = this.run(outputRoot, seconds);
  }

  private readonly message = (_event: unknown, method: string, params: Record<string, unknown>) => {
    if (!this.recording || this.closed) return;
    if (method === "Tracing.bufferUsage") {
      if (typeof params.percentFull === "number" && Number.isFinite(params.percentFull)) {
        this.bufferUsage.percentage = Math.max(this.bufferUsage.percentage, params.percentFull);
      }
      if (typeof params.eventCount === "number" && Number.isFinite(params.eventCount)) {
        this.bufferUsage.value = Math.max(this.bufferUsage.value, params.eventCount);
      }
    }
    if (method === "Tracing.tracingComplete") {
      if (typeof params.stream === "string") this.stream = params.stream;
      this.dataLossOccurred = typeof params.dataLossOccurred === "boolean" ? params.dataLossOccurred : null;
      this.completeResolve(this.stream);
    }
  };
  private readonly detached = () => { this.completeResolve(undefined); };

  private sample(): void {
    if (this.endRequested || this.closed) return;
    const atMs = Math.round(performance.now() - this.startedAt);
    this.sampleTask = sampleWindows(this.session!).then((state) => {
      this.samples.push({ atMs, state });
    }).catch(() => {
      // A disappearing window must not delay the owned trace's stop request.
    }).finally(() => {
      if (!this.endRequested && !this.closed) this.sampleTimer = setTimeout(() => this.sample(), 1000);
    });
  }

  stop(reason: "duration" | "manual" | "shutdown"): Promise<RenderingCaptureResult> {
    if (!this.endRequested) this.reason = reason;
    this.endRequested = true;
    clearTimeout(this.timer);
    clearTimeout(this.sampleTimer);
    if (this.recording && !this.endTask && !this.closed) {
      // No buffer request, renderer read or filesystem operation precedes end.
      this.endTask = this.session!.webContents.debugger.sendCommand("Tracing.end");
      void this.endTask.catch(() => {});
      this.stoppedAt = performance.now();
      this.stopTimer = setTimeout(() => this.completeResolve(undefined), TRANSFER_BUDGET_MS);
    }
    return this.result;
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

  private async run(outputRoot: string, seconds: number): Promise<RenderingCaptureResult> {
    let saved = false;
    try {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      this.directory = await mkdtemp(join(outputRoot, "rendering-"));
      // A dedicated, un-navigated target gives this capture an exclusive CDP
      // session. Destroying it cannot detach DevTools or a V8/native CPU profiler.
      const session = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      this.session = session;
      const d = session.webContents.debugger;
      this.debuggerApi = d;
      d.attach("1.3");
      d.on("message", this.message);
      d.on("detach", this.detached);
      this.startedAt = performance.now();
      this.timer = setTimeout(() => { void this.stop("duration").catch(() => {}); }, seconds * 1000);
      // contentTracing.startRecording resolves even when it did not start a
      // recording. CDP rejects conflicts; only this acknowledgement grants ownership.
      await this.bounded(d.sendCommand("Tracing.start", {
        transferMode: "ReturnAsStream", streamFormat: "json", streamCompression: "none",
        bufferUsageReportingInterval: 250,
        traceConfig: {
          recordMode: "recordUntilFull", traceBufferSizeInKb: 8192, enableArgumentFilter: true,
          includedCategories: RENDERING_TRACE_CONFIG.included_categories,
          excludedCategories: RENDERING_TRACE_CONFIG.excluded_categories,
        },
      }), this.startedAt + TRANSFER_BUDGET_MS);
      this.recording = true;
      if (this.endRequested) void this.stop(this.reason).catch(() => {});
      else this.sample();
      const stream = await this.bounded(this.complete, this.startedAt + seconds * 1000 + TRANSFER_BUDGET_MS);
      clearTimeout(this.stopTimer);
      if (!stream || !this.endTask) throw failure();
      const deadline = performance.now() + TRANSFER_BUDGET_MS;
      await this.bounded(this.endTask, deadline);
      this.recording = false;
      const durationMs = Math.round(this.stoppedAt - this.startedAt);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for (let reads = 0; ; reads++) {
        if (reads > DECODE_CAP / READ_BYTES) throw failure();
        const chunk = await this.bounded(d.sendCommand("IO.read", { handle: stream, size: READ_BYTES }), deadline);
        if (typeof chunk.data !== "string") throw failure();
        const encoding = chunk.base64Encoded ? "base64" : "utf8";
        const size = Buffer.byteLength(chunk.data, encoding);
        if (size > READ_BYTES || bytes + size > DECODE_CAP) throw failure();
        chunks.push(Buffer.from(chunk.data, encoding));
        bytes += size;
        if (chunk.eof) break;
      }
      await this.bounded(d.sendCommand("IO.close", { handle: stream }), deadline);
      this.stream = undefined;
      await this.sampleTask;
      const trace = summarizeRenderingTrace(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      const summaryPath = join(this.directory, "summary.json");
      await writeFile(summaryPath, JSON.stringify({
        version: 1, reason: this.reason, durationMs, bufferUsage: this.bufferUsage,
        dataLossOccurred: this.dataLossOccurred,
        updateEventNames: RENDERER_UPDATE_EVENT_NAMES, trace, samples: this.samples,
      }, null, 2), { mode: 0o600, flag: "wx" });
      saved = true;
      return { summaryPath, durationMs };
    } catch {
      // Never export protocol/JSON errors, which can contain paths or page data.
      throw failure();
    } finally {
      this.closed = true;
      clearTimeout(this.timer);
      clearTimeout(this.stopTimer);
      clearTimeout(this.sampleTimer);
      if (this.session && this.debuggerApi) {
        const d = this.debuggerApi;
        if (this.stream && !this.session.isDestroyed() && d.isAttached()) {
          await this.bounded(d.sendCommand("IO.close", { handle: this.stream }), performance.now() + 1000).catch(() => {});
        }
        d.off("message", this.message);
        d.off("detach", this.detached);
        // The CDP handler tears down its own trace on detach, including a late
        // start acknowledgement or a stuck end/transfer. Never use a global stop.
        if (!this.session.isDestroyed()) this.session.destroy();
      }
      if (!saved && this.directory) await rm(this.directory, { recursive: true, force: true });
    }
  }
}

let active: RenderingCapture | undefined;

export async function captureRenderingDiagnostics(outputRoot: string, seconds: unknown = 10): Promise<RenderingCaptureResult> {
  if (active) throw new Error("A rendering capture is already active");
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > 30) {
    throw new Error("Rendering capture duration must be between 1 and 30 seconds");
  }
  const releaseTrace = acquireChromiumTrace();
  const capture = new RenderingCapture(outputRoot, seconds);
  active = capture;
  try {
    return await capture.result;
  } finally {
    if (active === capture) active = undefined;
    releaseTrace();
  }
}

export async function stopRenderingDiagnostics(reason: "manual" | "shutdown" = "manual") {
  return active?.stop(reason);
}
