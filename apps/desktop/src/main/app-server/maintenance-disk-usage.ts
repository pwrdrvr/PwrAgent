import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { ThreadMaintenanceSpace } from "@pwragent/shared";
import { maintenanceLockHelperPath } from "./maintenance-native-lock";

const execute = promisify(execFile);

async function measureWindowsAllocation(paths: string[], signal: AbortSignal, helperPath: string): Promise<ThreadMaintenanceSpace | undefined> {
  try {
    const { stdout } = await execute(helperPath, ["--maintenance-allocation", ...paths.map((value) => path.resolve(value))], {
      signal, timeout: 30_000, maxBuffer: 8192, windowsHide: true,
    });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || !("allocatedBytes" in result)) return undefined;
    const bytes = result.allocatedBytes;
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) return undefined;
    if ("lowerBound" in result && typeof result.lowerBound !== "boolean") return undefined;
    return { allocatedBytes: bytes, ...("lowerBound" in result && result.lowerBound ? { lowerBound: true } : {}) };
  } catch {
    // Missing helper, inaccessible files, cancellation and unsupported native
    // queries are unknown. Never substitute logical lengths or zero.
    return undefined;
  }
}

/** Native allocation accounting, with bounded output and lifetime. du does
 * not follow symlinks and counts hardlinks once within each checkout. APFS
 * clone blocks can be counted repeatedly: this is allocation, never private
 * allocation or a promise of recovered space. No provider storage is read. */
export async function measureMaintenanceAllocation(
  checkout: string,
  signal: AbortSignal,
  options: { helperPath?: string } = {},
): Promise<ThreadMaintenanceSpace | undefined> {
  if (process.platform === "win32") return measureWindowsAllocation([checkout], signal, options.helperPath ?? maintenanceLockHelperPath());
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

/** One native invocation counts hardlinks once across all selected children. */
export async function measureMaintenanceAllocationPaths(paths: string[], signal: AbortSignal,
  options: { helperPath?: string } = {}): Promise<ThreadMaintenanceSpace | undefined> {
  if (!paths.length) return { allocatedBytes: 0 };
  if (paths.length > 1000) return undefined;
  if (process.platform === "win32") return measureWindowsAllocation(paths, signal, options.helperPath ?? maintenanceLockHelperPath());
  try {
    const { stdout } = await execute("/usr/bin/du", ["-skc", ...paths.map((value) => path.resolve(value))], {
      signal, timeout: 30_000, maxBuffer: 256 * 1024, env: { ...process.env, BLOCK_SIZE: "1024", LC_ALL: "C" },
    });
    const total = Number(/(?:^|\n)([0-9]+)\s+total\s*$/.exec(stdout)?.[1]);
    return Number.isSafeInteger(total) && total >= 0 ? { allocatedBytes: total * 1024 } : undefined;
  } catch { return undefined; }
}
