import type { RendererErrorReport } from "./renderer-error";

export const RENDERER_ERROR_REPEAT_INTERVAL_MS = 60_000;
export const MAX_RECENT_RENDERER_ERRORS = 64;
export type RendererErrorRepeat = NonNullable<RendererErrorReport["repeat"]>;

// Only bounded summaries belong in this table, never stacks or snapshots.
// One trailing timeout exists only while there are unreported repeats.
export function createRendererErrorCoalescer<T>(
  emit: (summary: T, repeat: RendererErrorRepeat) => void,
) {
  type Entry = { summary: T; started: number; count: number; first: number; last: number };
  const recent = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerDeadline = Infinity;

  function flush(entry: Entry): void {
    if (!entry.count) return;
    const repeat = {
      count: entry.count,
      firstTimestamp: new Date(entry.first).toISOString(),
      lastTimestamp: new Date(entry.last).toISOString(),
    };
    entry.count = 0;
    emit(entry.summary, repeat);
  }

  function schedule(deadlineHint = Infinity): void {
    if (timer !== undefined && deadlineHint >= timerDeadline) return;
    let deadline = deadlineHint;
    if (!Number.isFinite(deadline)) {
      for (const entry of recent.values()) {
        if (entry.count) deadline = Math.min(deadline, entry.started + RENDERER_ERROR_REPEAT_INTERVAL_MS);
      }
    }
    if (!Number.isFinite(deadline)) return;
    if (timer !== undefined) clearTimeout(timer);
    timerDeadline = deadline;
    timer = setTimeout(() => {
      timer = undefined;
      timerDeadline = Infinity;
      const now = Date.now();
      for (const [key, entry] of recent) {
        if (now < entry.started || now >= entry.started + RENDERER_ERROR_REPEAT_INTERVAL_MS) {
          recent.delete(key);
          flush(entry);
        }
      }
      schedule();
    }, Math.max(0, deadline - Date.now()));
  }

  return {
    // The factory runs only for an admitted fault, before its expensive capture.
    accept(key: string, summary: () => T, occurrences: number | RendererErrorRepeat = 1): boolean {
      const now = Date.now();
      const previous = recent.get(key);
      let reschedule = false;
      if (previous && now >= previous.started && now - previous.started < RENDERER_ERROR_REPEAT_INTERVAL_MS) {
        const count = typeof occurrences === "number" ? occurrences : occurrences.count;
        const first = typeof occurrences === "number" ? now : Date.parse(occurrences.firstTimestamp);
        const last = typeof occurrences === "number" ? now : Date.parse(occurrences.lastTimestamp);
        const validRange = Number.isFinite(first) && Number.isFinite(last) && first <= last;
        const firstOccurrence = validRange ? first : now;
        const lastOccurrence = validRange ? last : now;
        previous.first = previous.count ? Math.min(previous.first, firstOccurrence) : firstOccurrence;
        previous.last = previous.count ? Math.max(previous.last, lastOccurrence) : lastOccurrence;
        previous.count = Math.min(previous.count + count, Number.MAX_SAFE_INTEGER);
        schedule(previous.started + RENDERER_ERROR_REPEAT_INTERVAL_MS);
        return false;
      }
      if (previous) {
        recent.delete(key);
        flush(previous);
        reschedule = true;
      }
      if (recent.size >= MAX_RECENT_RENDERER_ERRORS) {
        const oldest = recent.entries().next().value;
        if (oldest) {
          recent.delete(oldest[0]);
          flush(oldest[1]);
          reschedule = true;
        }
      }
      recent.set(key, { summary: summary(), started: now, count: 0, first: now, last: now });
      if (reschedule && timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
        timerDeadline = Infinity;
        schedule();
      }
      return true;
    },
    dispose(this: void): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      timerDeadline = Infinity;
      for (const entry of recent.values()) flush(entry);
      recent.clear();
    },
  };
}

// Do not retain arbitrarily large strings, or unrecognized IPC fields, in the
// coalescer or summary log. Detail stacks have their own larger log budget.
export function rendererErrorSummary(report: RendererErrorReport): Omit<RendererErrorReport, "stack" | "componentStack" | "updateDiagnostics"> {
  const text = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (value.length <= limit) return value;
    // V8 sliced strings can retain the entire oversized backing string.
    // Copy only the bounded prefix before keeping it in a long-lived table.
    return value.slice(0, limit).split("").join("");
  };
  const coordinate = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  return {
    colno: coordinate(report.colno), lineno: coordinate(report.lineno),
    filename: text(report.filename, 2048), href: text(report.href, 2048) ?? "",
    message: text(report.message, 1024) ?? "Unknown renderer error",
    name: text(report.name, 128), source: report.source === "error-boundary" || report.source === "unhandled-rejection"
      ? report.source : "window-error",
    timestamp: text(report.timestamp, 64) ?? "", userAgent: text(report.userAgent, 512) ?? "",
    faultId: typeof report.faultId === "string" && /^[a-f0-9]{32}$/.test(report.faultId) ? report.faultId : undefined,
    reportingWindowId: typeof report.faultId === "string" && /^[a-f0-9]{32}$/.test(report.faultId)
      && typeof report.reportingWindowId === "string"
      && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(report.reportingWindowId)
      ? report.reportingWindowId : undefined,
    recovery: report.recovery && ["automatic-remount", "manual-remount", "stopped"].includes(report.recovery.action) ? {
      action: report.recovery.action, attempt: coordinate(report.recovery.attempt) ?? 0,
      limit: coordinate(report.recovery.limit) ?? 0,
    } : undefined,
  };
}
