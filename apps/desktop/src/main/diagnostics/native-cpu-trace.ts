// Only static labels and numeric IDs/timing cross the raw trace boundary.
const CATEGORIES = new Set(["toplevel", "devtools.timeline", "ipc", "mojom", "v8.execute"]);
const NAMES = new Set([
  "Layout", "UpdateLayoutTree", "Paint", "PrePaint", "CompositeLayers",
  "FunctionCall", "TimerFire", "FireAnimationFrame", "EvaluateScript",
  "RunTask", "ThreadControllerImpl::RunTask", "ThreadPool_RunTask", "V8.Execute",
  "Receive mojo message", "Receive mojo reply",
]);
const ROLES = new Set([
  "CrRendererMain", "CrBrowserMain", "CrGpuMain", "Compositor", "VizCompositorThread",
  "DedicatedWorker thread", "Chrome_IOThread", "ThreadPoolForegroundWorker",
]);
export const MAX_NATIVE_SPANS = 100_000;
const MAX_EVENTS = 250_000;
type Event = Record<string, unknown>;
type Span = {
  pid: number; tid: number; name: string; ts: number; dur: number;
  tts: number | null; tdur: number | null; parent: number | null;
};
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const id = (n: unknown): n is number => finite(n) && Number.isSafeInteger(n);

function label(e: Event): string {
  if (NAMES.has(e.name as string)) return e.name as string;
  const cats = typeof e.cat === "string" ? e.cat.split(",") : [];
  if (cats.includes("ipc") || cats.includes("mojom")) return "ipc-or-mojo";
  if (cats.includes("v8.execute")) return "v8-execution";
  return "other-synchronous-work";
}

function union(intervals: [number, number][]): number {
  intervals.sort((a, b) => a[0] - b[0]);
  let end = -Infinity, total = 0;
  for (const [start, next] of intervals) {
    total += Math.max(0, next - Math.max(start, end));
    end = Math.max(end, next);
  }
  return total;
}

/** Spans are inclusive. Unions prevent a 700ms JS child of a 700ms IPC task
 * from becoming 1400ms of work. Missing thread timing is never wall-time CPU. */
export function summarizeNativeCpuTrace(trace: { traceEvents?: Event[] }) {
  if (!Array.isArray(trace.traceEvents) || trace.traceEvents.length > MAX_EVENTS) {
    throw new Error("Native trace event budget exceeded");
  }
  const spans: Span[] = [];
  const roles = new Map<string, string>();
  const stacks = new Map<string, Event[]>();
  let firstTs = Infinity, lastTs = -Infinity, incomplete = 0, omittedSpans = 0;
  const add = (e: Event, dur: number, tdur: unknown) => {
    if (!id(e.pid) || !id(e.tid) || !finite(e.ts) || !finite(dur) || !finite(e.ts + dur)) return;
    if (spans.length >= MAX_NATIVE_SPANS) { omittedSpans++; return; }
    spans.push({ pid: e.pid, tid: e.tid, name: label(e), ts: e.ts, dur,
      tts: finite(e.tts) ? e.tts : null, tdur: finite(tdur) ? tdur : null, parent: null });
  };
  for (const e of trace.traceEvents) {
    if (!id(e.pid) || !id(e.tid)) continue;
    const key = `${e.pid}:${e.tid}`;
    if (e.ph === "M") {
      if (e.name === "thread_name") {
        const name = (e.args as { name?: unknown } | undefined)?.name;
        roles.set(key, ROLES.has(name as string) ? name as string : "other");
      }
      continue;
    }
    if (!finite(e.ts)) continue;
    firstTs = Math.min(firstTs, e.ts);
    lastTs = Math.max(lastTs, e.ts + (finite(e.dur) ? e.dur : 0));
    const allowed = typeof e.cat === "string" && e.cat.split(",").some((c) => CATEGORIES.has(c));
    if (e.ph === "B") {
      let stack = stacks.get(key);
      if (!stack) stacks.set(key, stack = []);
      stack.push(e);
    } else if (e.ph === "E") {
      const start = stacks.get(key)?.pop();
      if (!start) { incomplete++; continue; }
      if (typeof start.cat === "string" && start.cat.split(",").some((c) => CATEGORIES.has(c))) {
        add(start, e.ts - (start.ts as number), finite(e.tts) && finite(start.tts) ? e.tts - start.tts : null);
      }
    } else if (e.ph === "X" && allowed && finite(e.dur)) {
      add(e, e.dur, e.tdur);
    }
  }
  for (const stack of stacks.values()) incomplete += stack.length;
  spans.sort((a, b) => a.pid - b.pid || a.tid - b.tid || a.ts - b.ts || b.dur - a.dur);
  const threads = new Map<string, { pid: number; tid: number; role: string; indices: number[] }>();
  let crossingSpans = 0;
  let parents: number[] = [];
  let previousKey = "";
  spans.forEach((span, index) => {
    const key = `${span.pid}:${span.tid}`;
    if (key !== previousKey) { parents = []; previousKey = key; }
    while (parents.length && spans[parents.at(-1)!].ts + spans[parents.at(-1)!].dur <= span.ts) parents.pop();
    if (parents.length) {
      const p = parents.at(-1)!;
      if (span.ts + span.dur <= spans[p].ts + spans[p].dur) span.parent = p;
      else crossingSpans++;
    }
    parents.push(index);
    let thread = threads.get(key);
    if (!thread) threads.set(key, thread = { pid: span.pid, tid: span.tid, role: roles.get(key) ?? "unknown", indices: [] });
    thread.indices.push(index);
  });
  return {
    units: "microseconds", semantics: "inclusive-spans-and-unions; never exclusive native CPU",
    coverage: {
      firstTraceTs: finite(firstTs) ? firstTs : null, lastTraceTs: finite(lastTs) ? lastTs : null,
      observedRangeUs: finite(firstTs) && finite(lastTs) ? lastTs - firstTs : 0,
      incompleteSpans: incomplete, crossingSpans, omittedSpans,
      // recordUntilFull does not overwrite. Full buffers can lose the tail.
      overwritten: false,
    },
    threads: [...threads.values()].map(({ indices, ...thread }) => {
      const items = indices.map((i) => spans[i]);
      const timed = items.filter((s) => s.tts !== null && s.tdur !== null);
      return { ...thread, spanCount: items.length, threadTimedSpans: timed.length,
        wallUnionUs: union(items.map((s) => [s.ts, s.ts + s.dur])),
        threadCpuUnionUs: timed.length ? union(timed.map((s) => [s.tts!, s.tts! + s.tdur!])) : null };
    }),
    spans,
  };
}
