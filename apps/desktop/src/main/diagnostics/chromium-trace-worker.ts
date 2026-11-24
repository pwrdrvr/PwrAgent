import { parentPort } from "node:worker_threads";
import { filterChromiumTrace } from "./chromium-trace-filter";
import type { ChromiumTraceChunk, FilteredChromiumTrace } from "./chromium-trace";

export type ChromiumTraceWorkerResult = Omit<FilteredChromiumTrace, "filterCpuMs">;

if (!parentPort) throw new Error("Invalid Chromium trace worker invocation");
const port = parentPort;
const buffers: Buffer[] = [];

port.on("message", (chunk: ChromiumTraceChunk | null) => {
  if (chunk) {
    buffers.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
    return;
  }
  try {
    const started = performance.now();
    const json = JSON.stringify(filterChromiumTrace(JSON.parse(Buffer.concat(buffers).toString("utf8"))));
    const bytes = new TextEncoder().encode(json);
    port.postMessage({
      bytes, filterPid: process.pid, filterElapsedMs: performance.now() - started,
    } satisfies ChromiumTraceWorkerResult, [bytes.buffer]);
  } catch {
    // Parsed input and error messages can contain private page data.
    port.postMessage("invalid-data");
  } finally {
    buffers.length = 0;
    port.close();
  }
});
