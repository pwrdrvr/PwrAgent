import { spawn } from "node:child_process";
import { addAbortListener } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { windowsJobCleanupVerified, wrapCommandInWindowsJob } from "../main/windows-job-wrapper";

class NativeFixtureDrainUnconfirmedError extends Error {}

export async function runNativeFixtureCommand(command: string, args: string[], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const windowsJob = process.platform === "win32"
    ? wrapCommandInWindowsJob({ command, args, env: process.env, terminateDescendantsOnExit: true, keepDrainEvidenceOnStop: Boolean(signal) })
    : undefined;
  let preserveJobEvidence = false;
  try {
    const child = spawn(windowsJob?.command ?? command, windowsJob?.args ?? args, {
      env: windowsJob?.env ?? process.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const record = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-8192); };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    let error: Error | undefined;
    child.on("error", (cause) => { error = cause; });
    using _stop = signal && addAbortListener(signal, () => {
      if (!child.pid) return;
      if (windowsJob) {
        try {
          windowsJob.requestStop!();
        } catch {
          // Closing the wrapper still closes its kill-on-close Job handle.
          // Preserve the outputs below if we cannot verify the drain.
          child.kill("SIGKILL");
        }
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") error = cause as Error;
        }
      }
    });
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    // On Windows, the wrapper closes only after the kernel reports zero Job
    // members. POSIX owns a fresh process group, including descendants that
    // closed stdio and outlived the compiler driver.
    if (process.platform !== "win32" && child.pid) {
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (cause) {
          const code = (cause as NodeJS.ErrnoException).code;
          if (code === "ESRCH") break;
          // EPERM does not establish that the group has gone. As in
          // process-tree.ts, it still counts as present.
          if (code !== "EPERM") throw cause;
        }
        await setTimeout(10);
      }
    }
    if (signal?.aborted && windowsJob && child.pid && !windowsJobCleanupVerified(windowsJob)) {
      preserveJobEvidence = true;
      throw new NativeFixtureDrainUnconfirmedError("The native fixture Job exited without confirming cleanup", { cause: signal.reason });
    }
    if (error) throw error;
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`Native fixture build exited ${code}: ${output}`);
  } finally {
    if (!preserveJobEvidence) windowsJob?.cleanup();
  }
}

export function createNativeHelperFixture<T>(build: (root: string) => Promise<T>) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "pwragent-native-test-")));
  const ready = Promise.resolve().then(() => build(root));
  // The readiness caller still receives the failure. Disposal may be its
  // first observer when setup fails or a run is cancelled.
  void ready.catch(() => {});
  let disposal: Promise<void> | undefined;
  return {
    root,
    ready,
    dispose(): Promise<void> {
      disposal ??= (async () => {
        try {
          await ready;
        } catch (error) {
          if (error instanceof NativeFixtureDrainUnconfirmedError) return;
        }
        rmSync(root, { recursive: true, force: true });
      })();
      return disposal;
    },
  };
}
