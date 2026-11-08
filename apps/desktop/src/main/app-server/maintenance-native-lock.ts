import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type MaintenanceLock = { assertHeld: () => void; release: () => Promise<void> };

/** Same packaged native helper as local MCP IPC; this mode only holds an
 * existing file lock. stdin lifetime owns the lock, including parent crashes. */
export function maintenanceLockHelperPath(): string {
  const filename = `mcp-ipc-relay${process.platform === "win32" ? ".exe" : ""}`;
  const resources = process.resourcesPath;
  return resources && !resources.includes("node_modules")
    ? path.join(resources, "mcp-ipc-relay", filename)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../build/mcp-ipc-relay", `${process.platform}-${process.arch}`, filename);
}

/** Undefined means a competing shared or exclusive lock. Missing helpers,
 * unsupported locks and changed files are errors, never permission to clean. */
export async function acquireMaintenanceLock(
  lockPath: string,
  helperPath = maintenanceLockHelperPath(),
): Promise<MaintenanceLock | undefined> {
  const child = spawn(helperPath, ["--maintenance-lock", lockPath], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
