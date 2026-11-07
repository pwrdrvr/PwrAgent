import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ThreadMaintenanceSpace } from "@pwragent/shared";

const execute = promisify(execFile);

/** Native allocation accounting, with bounded output and lifetime. du does
 * not follow symlinks and counts hardlinks once within each checkout. APFS
 * clone blocks can be counted repeatedly: this is allocation, never private
 * allocation or a promise of recovered space. No provider storage is read. */
export async function measureMaintenanceAllocation(
  checkout: string,
  signal: AbortSignal,
): Promise<ThreadMaintenanceSpace | undefined> {
  if (process.platform === "win32") return undefined;
  try {
    const { stdout } = await execute("/usr/bin/du", ["-sk", path.resolve(checkout)], {
      signal, timeout: 30_000, maxBuffer: 8192,
      env: { ...process.env, BLOCK_SIZE: "1024", LC_ALL: "C" },
    });
    const kibibytes = Number(/^([0-9]+)\s/.exec(stdout)?.[1]);
    return Number.isSafeInteger(kibibytes) && kibibytes >= 0
      ? { allocatedBytes: kibibytes * 1024 } : undefined;
  } catch {
    // Permission failures, disappearance and timeouts are unknown, not zero.
    return undefined;
  }
}
