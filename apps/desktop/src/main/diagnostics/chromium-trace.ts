import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { onChromiumTraceReleased, tryAcquireChromiumTrace } from "./chromium-trace-lease";

const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];
const TRACE_BUFFER_KB = 32 * 1024;
const MAX_RAW_TRACE_BYTES = 96 * 1024 * 1024;
const START_TIMEOUT_MS = 1_000;
const STOP_TIMEOUT_MS = 4_000;
const NO_TRACE_IN_PROGRESS = "Failed to stop tracing - no trace in progress";

// Electron's declaration spells this recording_mode. Its native binding
// passes the dictionary to Chromium, which reads record_mode.
type ChromiumTraceConfig = {
  record_mode: "record-continuously";
  trace_buffer_size_in_kb: number;
  included_categories: string[];
  excluded_categories: string[];
};

type TraceBackend = {
  startRecording: (config: ChromiumTraceConfig) => Promise<void>;
  stopRecording: (filePath: string) => Promise<string>;
};

type TraceCapture =
  | { status: "written"; recordingStartedAtMs: number; recordingStoppedAtMs: number }
  | { status: "skipped"; reason: "not-recording" | "trigger-predates-recording" }
  | { status: "failed" };

type TraceOptions = {
  wallNow?: () => number;
  monotonicNow?: () => number;
  bufferSizeKb?: number;
  startTimeoutMs?: number;
  stopTimeoutMs?: number;
};

async function withDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Chromium tracing timed out")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// The native JSON exporter can include URLs, arbitrary User Timing labels and
// nested metadata. Construct events using only timing fields and fixed labels.
const TIMING_NAMES = new Set([
  "RunTask", "ThreadControllerImpl::RunTask", "FunctionCall", "EvaluateScript",
  "UpdateLayoutTree", "RecalculateStyles", "Layout", "PrePaint", "Paint",
  "PaintImage", "RasterTask", "CompositeLayers", "Commit", "DrawFrame",
  "BeginFrame", "BeginMainThreadFrame", "FireAnimationFrame", "EventDispatch",
  "ResourceSendRequest", "ResourceReceiveResponse", "ResourceFinish",
  "Graphics.Pipeline", "Scheduler::BeginFrame", "LayerTreeHostImpl::NotifyTileStateChanged",
  "RasterizerTaskImpl::RunOnWorkerThread", "GpuRasterBuffer::Playback",
  "DisplayScheduler::ScheduleBeginFrameDeadline", "ExternalBeginFrameSource::OnBeginFrame",
]);
const TRACK_NAMES = new Set([
  "Browser", "Renderer", "GPU Process", "CrBrowserMain", "CrRendererMain",
  "CrGpuMain", "Compositor", "VizCompositorThread", "CompositorTileWorker",
  "ThreadPoolForegroundWorker", "ThreadPoolBackgroundWorker",
]);
const TIMING_PHASES = new Set(["B", "E", "X", "I", "i", "R"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function filterEvent(value: unknown): Record<string, unknown> | undefined {
  const event = record(value);
  if (!event || !finite(event.pid) || !finite(event.tid)) return;
  const track = { pid: event.pid, tid: event.tid };
  if (event.ph === "M" && (event.name === "thread_name" || event.name === "process_name")) {
    const name = record(event.args)?.name;
    if (typeof name === "string" && TRACK_NAMES.has(name)) {
      return { ...track, ph: "M", cat: "__metadata", name: event.name, args: { name } };
    }
    return;
  }

  if (typeof event.ph !== "string" || !TIMING_PHASES.has(event.ph)
    || !finite(event.ts) || typeof event.cat !== "string") return;
  const categories = event.cat.split(",");
  const cat = TRACE_CATEGORIES.filter((known) => categories.includes(known)).join(",");
  if (!cat) return;
  const name = typeof event.name === "string" && TIMING_NAMES.has(event.name)
    ? event.name
    : categories.includes("blink.user_timing") ? "User timing" : "Other";
  const safe: Record<string, unknown> = { ...track, cat, name, ph: event.ph, ts: event.ts };
  for (const key of ["dur", "tts", "tdur"]) {
    if (finite(event[key])) safe[key] = event[key];
  }
  if (event.ph === "I" || event.ph === "i") safe.s = "t";
  return safe;
}

export function filterChromiumTrace(value: unknown): { traceEvents: Record<string, unknown>[] } {
  const rawEvents = record(value)?.traceEvents;
  if (!Array.isArray(rawEvents)) throw new Error("Chromium trace has no event array");
  const traceEvents = [];
  for (const event of rawEvents) {
    const safe = filterEvent(event);
    if (safe) traceEvents.push(safe);
  }
  return { traceEvents };
}

async function publishTrace(rawPath: string, filePath: string): Promise<void> {
  if ((await fs.stat(rawPath)).size > MAX_RAW_TRACE_BYTES) {
    throw new Error("Chromium trace exceeded the export size limit");
  }
  const filtered = filterChromiumTrace(JSON.parse(await fs.readFile(rawPath, "utf8")));
  const pendingPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(pendingPath, JSON.stringify(filtered), { encoding: "utf8", mode: 0o600 });
    await fs.rename(pendingPath, filePath);
  } finally {
    await fs.rm(pendingPath, { force: true });
  }
}

/** Electron has one native trace for the app. Keep it armed while a renderer
 * can still capture, including while it is flushing its final CPU profile. */
export class ChromiumTrace {
  private readonly renderers = new Set<object>();
  private queue: Promise<unknown> = Promise.resolve();
  private recording: { wallMs: number; monotonicMs: number } | undefined;
  // After a native timeout we keep ownership until a stop confirms the state.
  private releaseNative: (() => void) | undefined;
  private unsubscribeNative: (() => void) | undefined;
  private readonly onNativeReleased = () => { void this.enqueue(() => this.reconcile()); };

  constructor(
    private readonly backend: () => TraceBackend,
    private readonly warn: (message: string) => void,
    private readonly options: TraceOptions = {},
  ) {}

  arm(renderer: object): Promise<void> {
    this.renderers.add(renderer);
    return this.enqueue(() => this.reconcile());
  }

  release(renderer: object): Promise<void> {
    if (!this.renderers.delete(renderer)) return Promise.resolve();
    return this.enqueue(() => this.reconcile());
  }

  capture(renderer: object, filePath: string, triggerMonotonicMs: number): Promise<TraceCapture> {
    return this.enqueue(async () => {
      const recording = this.recording;
      if (!this.renderers.has(renderer) || !recording) {
        return { status: "skipped", reason: "not-recording" };
      }
      if (triggerMonotonicMs <= recording.monotonicMs) {
        return { status: "skipped", reason: "trigger-predates-recording" };
      }
      const recordingStoppedAtMs = this.options.wallNow?.() ?? Date.now();
      try {
        await this.stop((rawPath) => publishTrace(rawPath, filePath));
        return { status: "written", recordingStartedAtMs: recording.wallMs, recordingStoppedAtMs };
      } catch {
        // Parse errors can contain snippets of the private input.
        this.warn("Could not save Chromium trace");
        return { status: "failed" };
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async reconcile(): Promise<void> {
    if (this.renderers.size > 0 && this.recording) return;
    this.unsubscribeNative?.();
    this.unsubscribeNative = undefined;
    if (this.releaseNative) {
      try {
        await this.stop();
      } catch (error) {
        if (!(error instanceof Error) || error.message !== NO_TRACE_IN_PROGRESS) {
          this.warn("Could not discard Chromium trace");
          return;
        }
        this.releaseNative();
        this.releaseNative = undefined;
      }
    }
    if (this.renderers.size === 0) return;

    this.releaseNative = tryAcquireChromiumTrace();
    if (!this.releaseNative) {
      this.unsubscribeNative = onChromiumTraceReleased(this.onNativeReleased);
      return;
    }
    try {
      // A timeout leaves the native state uncertain. The next reconcile
      // discards that recording before trying to arm again.
      await withDeadline(this.backend().startRecording({
        record_mode: "record-continuously",
        trace_buffer_size_in_kb: this.options.bufferSizeKb ?? TRACE_BUFFER_KB,
        included_categories: [...TRACE_CATEGORIES],
        excluded_categories: ["*"],
      }), this.options.startTimeoutMs ?? START_TIMEOUT_MS);
      this.recording = {
        wallMs: this.options.wallNow?.() ?? Date.now(),
        monotonicMs: this.options.monotonicNow?.() ?? performance.now(),
      };
    } catch {
      this.warn("Could not arm Chromium trace");
    }
  }

  private async stop(publish?: (rawPath: string) => Promise<void>): Promise<void> {
    this.recording = undefined;
    // Chromium stages temporary files beside the destination. A private
    // directory outside the session also isolates any late native writes.
    const scratch = await fs.mkdtemp(path.join(tmpdir(), "pwragent-chromium-trace-"));
    const rawPath = path.join(scratch, "trace.json");
    const release = this.releaseNative;
    try {
      const operation = this.backend().stopRecording(rawPath);
      try {
        await withDeadline(operation, this.options.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      } catch (error) {
        // A late acknowledgement only retires its own lease. Its raw file is
        // never published, and a new trace can arm if renderers still need it.
        void operation.then(() => this.enqueue(async () => {
          if (this.releaseNative !== release) return;
          release?.();
          this.releaseNative = undefined;
          await this.reconcile();
        }), () => undefined);
        throw error;
      }
      this.releaseNative?.();
      this.releaseNative = undefined;
      await publish?.(rawPath);
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {
        this.warn("Could not remove private Chromium trace staging directory");
      });
    }
  }
}
