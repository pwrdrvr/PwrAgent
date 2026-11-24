import { Worker } from "node:worker_threads";
import { ChromiumTraceExportError, type ProcessChromiumTrace } from "./chromium-trace";

const MAX_RAW_TRACE_BYTES = 48 * 1024 * 1024;

export function chromiumTraceProcessor(workerPath: string): ProcessChromiumTrace {
  return async (chunks, signal, reportPhase) => {
    signal.throwIfAborted();
    let worker: Worker;
    try {
      worker = new Worker(workerPath);
    } catch {
      throw new ChromiumTraceExportError("worker", "filter");
    }
    const complete = new Promise<Uint8Array>((resolve, reject) => {
      const workerFailed = () => reject(new ChromiumTraceExportError("worker", "filter"));
      worker.once("message", (message: unknown) => {
        if (message instanceof Uint8Array) resolve(message);
        else if (message === "invalid-data") reject(new ChromiumTraceExportError("invalid-data", "filter"));
        else workerFailed();
      });
      worker.once("error", workerFailed);
      worker.once("exit", workerFailed);
    });
    const abort = () => { void worker.terminate().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let closed = false;
    const transfer = async () => {
      let bytes = 0;
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        if (closed) break;
        bytes += Buffer.byteLength(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (bytes > MAX_RAW_TRACE_BYTES) throw new ChromiumTraceExportError("limit", "stream-read");
        worker.postMessage(chunk);
      }
      signal.throwIfAborted();
      if (!closed) {
        reportPhase?.("filter");
        worker.postMessage(null);
      }
      return complete;
    };
    try {
      // A missing or defective worker can fail before Chromium opens the stream.
      const filtered = await Promise.race([transfer(), complete]);
      signal.throwIfAborted();
      return filtered;
    } finally {
      closed = true;
      signal.removeEventListener("abort", abort);
      await worker.terminate().catch(() => {});
    }
  };
}
