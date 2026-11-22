export const TRACE_CATEGORIES = ["devtools.timeline", "blink.user_timing", "cc", "viz"];

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
