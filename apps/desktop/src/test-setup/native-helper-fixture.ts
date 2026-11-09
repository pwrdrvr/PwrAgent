import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { wrapCommandInWindowsJob } from "../main/windows-job-wrapper";

export async function runNativeFixtureCommand(command: string, args: string[]): Promise<void> {
  const launch = process.platform === "win32"
    ? wrapCommandInWindowsJob({ command, args, env: process.env, terminateDescendantsOnExit: true })
    : { command, args, env: process.env, cleanup: () => {} };
  try {
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
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
    if (error) throw error;
    if (code !== 0) throw new Error(`Native fixture build exited ${code}: ${output}`);
  } finally {
    launch.cleanup();
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
        await ready.catch(() => {});
        rmSync(root, { recursive: true, force: true });
      })();
      return disposal;
    },
  };
}
