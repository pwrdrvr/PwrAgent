import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Memory an instance could actually give to new work.
 *
 * `os.freemem()` is not that number on every platform, and on macOS it is
 * badly misleading: it reports only truly free pages, so a healthy 16 GB Mac
 * with a couple of GB of reclaimable file cache reports ~140 MB free while
 * Activity Monitor's pressure gauge sits in the green. Showing that figure as
 * "free RAM" reads as a machine about to die.
 *
 * Per platform:
 * - **macOS**: `vm_stat` page counts. Free + inactive + purgeable +
 *   speculative is the headroom the kernel can hand out without swapping,
 *   which is what the pressure gauge is really reflecting.
 * - **Linux**: `/proc/meminfo`'s `MemAvailable` — the kernel's own estimate
 *   of exactly this, so no arithmetic of ours can beat it.
 * - **Windows and anything else**: `os.freemem()`, which already maps to
 *   `GlobalMemoryStatusEx.ullAvailPhys` (available, not merely free).
 *
 * Every path falls back to `os.freemem()`: a wrong-but-present number beats a
 * missing metric on a health card, and the fallback is only ever pessimistic.
 */
export async function readAvailableMemoryBytes(options?: {
  platform?: NodeJS.Platform;
  runVmStat?: () => Promise<string>;
  readMemInfo?: () => Promise<string>;
}): Promise<number> {
  const platform = options?.platform ?? process.platform;
  try {
    if (platform === "darwin") {
      const parsed = parseVmStatAvailableBytes(
        await (options?.runVmStat?.() ?? runVmStat()),
      );
      if (parsed !== undefined) return parsed;
    } else if (platform === "linux") {
      const parsed = parseMemAvailableBytes(
        await (options?.readMemInfo?.() ?? readMemInfo()),
      );
      if (parsed !== undefined) return parsed;
    }
  } catch {
    // Sampling is best-effort; the fallback below is always available.
  }
  return os.freemem();
}

async function runVmStat(): Promise<string> {
  const { stdout } = await execFileAsync("vm_stat", [], {
    timeout: 2_000,
    windowsHide: true,
  });
  return stdout;
}

async function readMemInfo(): Promise<string> {
  return await fs.readFile("/proc/meminfo", "utf8");
}

/**
 * Sum the reclaimable page classes out of `vm_stat` output.
 *
 * Exported for tests: the format is stable but fiddly (a header line carrying
 * the page size, then `Key: value.` lines), and getting the page size wrong
 * silently scales the answer by 4096.
 */
export function parseVmStatAvailableBytes(stdout: string): number | undefined {
  const pageSize = /page size of (\d+) bytes/.exec(stdout);
  if (!pageSize) return undefined;
  const bytesPerPage = Number(pageSize[1]);
  if (!Number.isFinite(bytesPerPage) || bytesPerPage <= 0) return undefined;

  const pages = (label: string): number | undefined => {
    const match = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(stdout);
    return match ? Number(match[1]) : undefined;
  };
  const free = pages("Pages free");
  if (free === undefined) return undefined;
  // Inactive and speculative pages are backed by files or are already
  // reclaimable; purgeable pages the kernel will simply drop under demand.
  const reclaimable =
    free
    + (pages("Pages inactive") ?? 0)
    + (pages("Pages purgeable") ?? 0)
    + (pages("Pages speculative") ?? 0);
  return reclaimable * bytesPerPage;
}

/** `MemAvailable` in bytes, or undefined when the field is absent. */
export function parseMemAvailableBytes(contents: string): number | undefined {
  const match = /^MemAvailable:\s+(\d+)\s*kB$/m.exec(contents);
  if (!match) return undefined;
  const kib = Number(match[1]);
  return Number.isFinite(kib) ? kib * 1024 : undefined;
}
