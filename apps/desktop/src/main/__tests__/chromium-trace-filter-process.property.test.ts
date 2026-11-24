import { EventEmitter } from "node:events";
import { utilityProcess } from "electron";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { chromiumTraceProcessor } from "../diagnostics/chromium-trace-processor";
import { startChromiumTraceFilterProcess } from "../shell/diagnostics/chromium-trace-filter-process";

vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

it("owns the filter through exit and accepts only a complete, uncancelled result", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("before-spawn", "after-spawn", "after-message", "never"),
    fc.constantFrom("success", "wrong-pid", "invalid-data", "crash"),
    async (cancelAt, childOutcome) => {
      const child = Object.assign(new EventEmitter(), {
        pid: undefined as number | undefined,
        kill: vi.fn(() => true),
        postMessage: vi.fn(),
      });
      const fork = vi.mocked(utilityProcess.fork);
      fork.mockClear();
      fork.mockReturnValue(child as unknown as Electron.UtilityProcess);
      const processTrace = chromiumTraceProcessor(() => startChromiumTraceFilterProcess("filter.js"));
      const controller = new AbortController();
      async function* chunks() { yield { data: '{"traceEvents":[]}' }; }
      const filterPid = process.pid + 1;
      const filtered = { bytes: new Uint8Array([1, 2, 3]), filterCpuMs: 8, filterElapsedMs: 12, filterPid };
      let finished = false;
      const capture = processTrace(chunks(), controller.signal).then(
        (value) => { finished = true; return value; },
        (error: unknown) => { finished = true; return error; },
      );
      if (cancelAt === "before-spawn") controller.abort();
      expect(child.kill).not.toHaveBeenCalled();
      child.pid = filterPid;
      child.emit("spawn");
      if (cancelAt === "after-spawn") controller.abort();
      if (childOutcome === "success") child.emit("message", filtered);
      if (childOutcome === "wrong-pid") child.emit("message", { ...filtered, filterPid: process.pid });
      if (childOutcome === "invalid-data") child.emit("message", "invalid-data");
      if (cancelAt === "after-message") controller.abort();

      await expect(processTrace(chunks(), new AbortController().signal)).rejects
        .toMatchObject({ category: "worker", phase: "filter" });
      expect(finished).toBe(false);
      expect(fork).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(cancelAt === "never" ? 0 : 1);

      child.pid = undefined;
      child.emit("exit", cancelAt === "never" && (childOutcome === "success" || childOutcome === "wrong-pid") ? 0 : 1);
      const outcome = await capture;
      if (cancelAt !== "never") expect(outcome).toMatchObject({ name: "AbortError" });
      else if (childOutcome === "success") expect(outcome).toEqual(filtered);
      else expect(outcome).toMatchObject({
        category: childOutcome === "invalid-data" ? "invalid-data" : "worker", phase: "filter",
      });
    },
  ));
});
