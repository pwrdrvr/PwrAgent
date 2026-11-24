import { Worker } from "node:worker_threads";
import type { FilteredChromiumTrace } from "../../diagnostics/chromium-trace";
import type { ChromiumTraceWorkerResult } from "../../diagnostics/chromium-trace-worker";

const port = process.parentPort;
// The JSON export is bounded at 48 MiB on the browser side. A dense export
// can expand substantially during JSON.parse. Keep that heap in the utility.
const MAX_FILTER_OLD_GENERATION_MB = 768;

if (!port) throw new Error("Invalid Chromium trace utility invocation");
const worker = new Worker(new URL("./chromium-trace-worker.js", import.meta.url), {
  resourceLimits: { maxOldGenerationSizeMb: MAX_FILTER_OLD_GENERATION_MB },
});

let result: ChromiumTraceWorkerResult | "invalid-data" | undefined;
worker.once("message", (message: ChromiumTraceWorkerResult | "invalid-data") => { result = message; });
worker.on("error", () => {});
worker.once("exit", (code) => {
  if (code === 0 && result && result !== "invalid-data") {
    const { user, system } = process.cpuUsage();
    port.postMessage({
      ...result,
      filterCpuMs: (user + system) / 1_000,
    } satisfies FilteredChromiumTrace);
    process.exit(0);
  }
  if (result === "invalid-data") port.postMessage(result);
  process.exit(1);
});
port.on("message", ({ data }) => worker.postMessage(data));
