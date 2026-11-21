import fs from "node:fs/promises";
import { parentPort, workerData } from "node:worker_threads";
import { filterChromiumTrace } from "./chromium-trace-filter";
import type { ChromiumTraceChunk } from "./chromium-trace";

if (!parentPort || typeof workerData !== "string") throw new Error("Invalid Chromium trace worker invocation");
const port = parentPort;
const pendingPath = workerData;
const buffers: Buffer[] = [];

port.on("message", (chunk: ChromiumTraceChunk | null) => {
  if (chunk) {
    buffers.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
    return;
  }
  void publish();
});

async function publish(): Promise<void> {
  try {
    const filtered = filterChromiumTrace(JSON.parse(Buffer.concat(buffers).toString("utf8")));
    buffers.length = 0;
    await fs.writeFile(pendingPath, JSON.stringify(filtered), { encoding: "utf8", mode: 0o600 });
    port.postMessage(true);
  } catch {
    // Parsed input and error messages can contain private page data.
    port.postMessage(false);
  }
}
