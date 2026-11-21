import fs from "node:fs/promises";
import { Worker } from "node:worker_threads";
import type { PublishChromiumTrace } from "./chromium-trace";

const MAX_RAW_TRACE_BYTES = 96 * 1024 * 1024;

export function chromiumTracePublisher(workerPath: string): PublishChromiumTrace {
  return async (chunks, pendingPath, signal) => {
    const worker = new Worker(workerPath, { workerData: pendingPath });
    const complete = new Promise<void>((resolve, reject) => {
      worker.once("message", (saved: unknown) => {
        if (saved === true) resolve();
        else reject(new Error("Could not filter Chromium trace"));
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("Chromium trace filter stopped")));
    });
    // An early worker failure may arrive while a native read is pending.
    void complete.catch(() => {});
    const abort = () => { void worker.terminate().catch(() => {}); };
    signal.addEventListener("abort", abort, { once: true });
    let saved = false;
    try {
      let bytes = 0;
      for await (const chunk of chunks) {
        signal.throwIfAborted();
        bytes += Buffer.byteLength(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
        if (bytes > MAX_RAW_TRACE_BYTES) throw new Error("Chromium trace exceeded the export size limit");
        worker.postMessage(chunk);
      }
      signal.throwIfAborted();
      worker.postMessage(null);
      await complete;
      signal.throwIfAborted();
      saved = true;
    } finally {
      signal.removeEventListener("abort", abort);
      await worker.terminate();
      if (!saved || signal.aborted) await fs.rm(pendingPath, { force: true });
    }
  };
}
