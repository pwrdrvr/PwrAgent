import {
  ChromiumTraceExportError, type ChromiumTraceChunk, type FilteredChromiumTrace, type ProcessChromiumTrace,
} from "./chromium-trace";

const MAX_RAW_TRACE_BYTES = 48 * 1024 * 1024;

export type ChromiumTraceFilterProcess = {
  send: (chunk: ChromiumTraceChunk | null) => void;
  result: Promise<FilteredChromiumTrace>;
  close: () => Promise<void>;
};

export function chromiumTraceProcessor(startFilter: () => ChromiumTraceFilterProcess): ProcessChromiumTrace {
  // A deadline can return before the previous child has exited. Allow one
  // filter at a time even across cancelled captures.
  let active = false;
  return async (chunks, signal, reportPhase) => {
    signal.throwIfAborted();
    if (active) throw new ChromiumTraceExportError("worker", "filter");
    let filter: ChromiumTraceFilterProcess;
    try {
      filter = startFilter();
    } catch {
      throw new ChromiumTraceExportError("worker", "filter");
    }
    active = true;
    const abort = () => { void filter.close().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let closed = false;
    const transfer = async () => {
      let bytes = 0;
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        if (closed) break;
        bytes += Buffer.byteLength(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (bytes > MAX_RAW_TRACE_BYTES) throw new ChromiumTraceExportError("limit", "stream-read");
        filter.send(chunk);
      }
      signal.throwIfAborted();
      if (!closed) {
        reportPhase?.("filter");
        filter.send(null);
      }
    };
    try {
      // Either side may fail while the other is still waiting for data.
      const [filtered] = await Promise.all([filter.result, transfer()]);
      signal.throwIfAborted();
      return filtered;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      closed = true;
      signal.removeEventListener("abort", abort);
      await filter.close().catch(() => {});
      active = false;
    }
  };
}
