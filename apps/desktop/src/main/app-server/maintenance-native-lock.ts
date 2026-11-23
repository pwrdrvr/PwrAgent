import { spawn } from "node:child_process";
import { nativeRelayPath } from "../native-relay-path";

export type MaintenanceLock = { assertHeld: () => void; release: () => Promise<void> };

/** Undefined means a competing shared or exclusive lock. Missing helpers,
 * unsupported locks and changed files are errors, never permission to clean.
 * stdin lifetime owns the helper's lock, including parent crashes. */
export async function acquireMaintenanceLock(
  lockPath: string,
  helperPath = nativeRelayPath(),
): Promise<MaintenanceLock | undefined> {
  return await acquireNativeFileLock("--maintenance-lock", lockPath, helperPath);
}

export async function acquireNativeFileLock(
  command: "--maintenance-lock" | "--stack-lock",
  lockPath: string,
  helperPath = nativeRelayPath(),
): Promise<MaintenanceLock | undefined> {
  const child = spawn(helperPath, [command, lockPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stdin.on("error", () => { child.kill(); });
  let exited = false;
  const closed = new Promise<void>((resolve) => { child.once("close", () => { exited = true; resolve(); }); });
  return await new Promise<MaintenanceLock | undefined>((resolve, reject) => {
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error("Build lock verification timed out")); }, 3_000);
    child.stderr.resume();
    child.once("error", () => { clearTimeout(timer); reject(new Error("Native build lock verification unavailable")); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (ready) return;
      if (code === 2) resolve(undefined);
      else reject(new Error("Build lock could not be verified"));
    });
    child.stdout.once("data", (bytes: Buffer) => {
      clearTimeout(timer);
      if (bytes[0] !== 1) { child.kill(); reject(new Error("Invalid build lock response")); return; }
      ready = true;
      resolve({
        assertHeld: () => { if (exited || child.exitCode !== null || child.killed) throw new Error("Build lock was lost"); },
        release: async () => { child.stdin.end(); await closed; },
      });
    });
  });
}
