import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";
import { readRenderingSnapshot, type RenderingCaptureResult } from "../../shared/rendering-diagnostics";
import { RENDERER_UPDATE_EVENT_NAMES } from "../../shared/renderer-update-diagnostics";
import { RenderingTrace } from "./rendering-trace";

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

async function sampleWindows() {
  const windows = BrowserWindow.getAllWindows();
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

class RenderingCapture {
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sampleTimer: ReturnType<typeof setTimeout> | undefined;
  private samples: { atMs: number; state: Awaited<ReturnType<typeof sampleWindows>> }[] = [];
  private sampleTask: Promise<void> | undefined;
  private finishTask: Promise<void> | undefined;
  private directory = "";
  private trace: RenderingTrace | undefined;
  private resolve!: (result: RenderingCaptureResult) => void;
  private reject!: (error: unknown) => void;
  readonly result = new Promise<RenderingCaptureResult>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = reject;
  });
  private readonly startTask: Promise<void>;

  constructor(outputRoot: string, seconds: number) {
    this.startTask = this.start(outputRoot, seconds);
  }

  private async start(outputRoot: string, seconds: number): Promise<void> {
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(outputRoot, "rendering-"));
    const window = BrowserWindow.getAllWindows().find((candidate) =>
      !candidate.isDestroyed() && !candidate.webContents.isDestroyed());
    if (!window) throw new Error("No rendering trace target");
    this.trace = new RenderingTrace(window.webContents, () => { void this.stop("manual").catch(() => {}); });
    await this.trace.start();
    this.startedAt = performance.now();
    this.timer = setTimeout(() => { void this.stop("duration").catch(() => {}); }, seconds * 1000);
    this.sample();
  }

  private sample(): void {
    const atMs = Math.round(performance.now() - this.startedAt);
    this.sampleTask = sampleWindows().then((state) => {
      this.samples.push({ atMs, state });
    }).catch(() => {
      // A window can disappear at any point. Missing data must not stop tracing shutdown.
    }).finally(() => {
      if (!this.finishTask) this.sampleTimer = setTimeout(() => this.sample(), 1000);
    });
  }

  stop(reason: "duration" | "manual" | "shutdown"): Promise<RenderingCaptureResult> {
    this.finishTask ??= this.finish(reason);
    return this.result;
  }

  private async finish(reason: string): Promise<void> {
    const rawPath = () => join(this.directory, "raw.json");
    let result: RenderingCaptureResult | undefined;
    try {
      await this.startTask;
      clearTimeout(this.timer);
      clearTimeout(this.sampleTimer);
      await this.trace!.stop(rawPath());
      const bufferUsage = this.trace!.bufferUsage;
      const durationMs = Math.round(performance.now() - this.startedAt);
      await this.sampleTask;
      clearTimeout(this.sampleTimer);
      // The native buffer is bounded. Refuse an unexpectedly large JSON expansion.
      if ((await stat(rawPath())).size > 64 * 1024 * 1024) throw new Error("Rendering trace exceeded 64 MiB");
      const trace = summarizeRenderingTrace(JSON.parse(await readFile(rawPath(), "utf8")));
      const summaryPath = join(this.directory, "summary.json");
      await writeFile(summaryPath, JSON.stringify({
        version: 1, reason, durationMs, bufferUsage,
        updateEventNames: RENDERER_UPDATE_EVENT_NAMES, trace, samples: this.samples,
      }, null, 2), { mode: 0o600 });
      result = { summaryPath, durationMs };
    } catch {
      // Do not propagate Chromium errors, which can contain paths or page data.
    } finally {
      clearTimeout(this.timer);
      clearTimeout(this.sampleTimer);
      try {
        this.trace?.release();
      } catch {
        result = undefined;
      }
      if (this.directory) {
        try {
          await rm(rawPath(), { force: true });
        } catch {
          result = undefined;
        }
      }
    }
    if (result) this.resolve(result);
    else this.reject(new Error("Rendering capture failed; no summary is available"));
  }

  async run(): Promise<RenderingCaptureResult> {
    try {
      await this.startTask;
    } catch {
      void this.stop("manual").catch(() => {});
    }
    return this.result;
  }
}

let active: RenderingCapture | undefined;

export async function captureRenderingDiagnostics(outputRoot: string, seconds: unknown = 10): Promise<RenderingCaptureResult> {
  if (active) throw new Error("A rendering capture is already active");
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 1 || seconds > 30) {
    throw new Error("Rendering capture duration must be between 1 and 30 seconds");
  }
  const capture = new RenderingCapture(outputRoot, seconds);
  active = capture;
  try {
    return await capture.run();
  } finally {
    if (active === capture) active = undefined;
  }
}

export async function stopRenderingDiagnostics(reason: "manual" | "shutdown" = "manual") {
  return active?.stop(reason);
}
