import { utilityProcess } from "electron";
import { ChromiumTraceExportError, type FilteredChromiumTrace } from "../../diagnostics/chromium-trace";
import type { ChromiumTraceFilterProcess } from "../../diagnostics/chromium-trace-processor";

function isFilteredTrace(value: unknown, childPid: number | undefined): value is FilteredChromiumTrace {
  if (typeof value !== "object" || value === null) return false;
  const { bytes, filterCpuMs, filterElapsedMs, filterPid } = value as Partial<FilteredChromiumTrace>;
  return childPid !== undefined && childPid !== process.pid && filterPid === childPid
    && bytes instanceof Uint8Array
    && typeof filterCpuMs === "number" && Number.isFinite(filterCpuMs) && filterCpuMs >= 0
    && typeof filterElapsedMs === "number" && Number.isFinite(filterElapsedMs) && filterElapsedMs >= 0;
}

export function startChromiumTraceFilterProcess(entry: string): ChromiumTraceFilterProcess {
  const child = utilityProcess.fork(entry, [], { serviceName: "PwrAgent Chromium trace filter", stdio: "ignore" });
  let message: unknown;
  let childPid: number | undefined;
  let closing = false;
  let exited = false;
  child.once("message", (value: unknown) => { message = value; });
  // Fatal V8 errors are followed by exit. Do not log diagnostic report contents.
  child.on("error", () => {});
  child.once("spawn", () => {
    childPid = child.pid;
    if (closing) child.kill();
  });
  const exit = new Promise<number>((resolve) => child.once("exit", (code) => {
    exited = true;
    resolve(code);
  }));
  const result = exit.then((code) => {
    if (code === 0 && isFilteredTrace(message, childPid)) return message;
    throw new ChromiumTraceExportError(message === "invalid-data" ? "invalid-data" : "worker", "filter");
  });
  return {
    send: (chunk) => child.postMessage(chunk),
    result,
    async close() {
      if (!closing && !exited) {
        closing = true;
        if (child.pid !== undefined) child.kill();
      }
      await exit;
    },
  };
}
