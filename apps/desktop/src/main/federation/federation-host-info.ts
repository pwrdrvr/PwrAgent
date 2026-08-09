import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  FederationHostInfo,
  FederationLoadStatus,
} from "@pwragent/shared";
import { resolvePwragentRoot } from "../profile";

const MACHINE_ID_FILENAME = "machine-id";

/**
 * Machine-scoped identity for shared-hardware detection. Minted once at
 * `<pwragent root>/machine-id` and read by every profile on the machine, so
 * two enrolled profiles of one box advertise the same id and agents can tell
 * they compete for the same CPUs/RAM. A custom `PWRAGENT_HOME` gets its own
 * id — an isolated E2E root is deliberately not "the same machine" as the
 * operator's real profiles.
 */
export async function readOrCreateFederationMachineId(options?: {
  rootDir?: string;
}): Promise<string | undefined> {
  const rootDir = options?.rootDir ?? resolvePwragentRoot();
  const filePath = path.join(rootDir, MACHINE_ID_FILENAME);
  try {
    const existing = (await fs.readFile(filePath, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Missing or unreadable — fall through to mint.
  }
  const minted = `mach_${randomUUID()}`;
  try {
    await fs.mkdir(rootDir, { recursive: true });
    await fs.writeFile(filePath, `${minted}\n`, { flag: "wx" });
    return minted;
  } catch {
    // Lost a mint race or the root is read-only. Re-read; a concurrent
    // writer's id is as good as ours, and no id at all is survivable.
    try {
      const raced = (await fs.readFile(filePath, "utf8")).trim();
      return raced || undefined;
    } catch {
      return undefined;
    }
  }
}

/**
 * Static host facts advertised to enrolled federation peers.
 * `diskFreeBytes` measures the volume holding the PwrAgent root and is a
 * point-in-time snapshot — callers re-collect on reconnect/broadcast rather
 * than treating it as live.
 */
export async function collectFederationHostInfo(options?: {
  rootDir?: string;
}): Promise<FederationHostInfo> {
  const rootDir = options?.rootDir ?? resolvePwragentRoot();
  const machineId = await readOrCreateFederationMachineId({ rootDir });
  let diskFreeBytes: number | undefined;
  try {
    const stats = await fs.statfs(rootDir);
    diskFreeBytes = stats.bavail * stats.bsize;
  } catch {
    diskFreeBytes = undefined;
  }
  return {
    platform: process.platform,
    osVersion: os.release(),
    hostname: os.hostname(),
    arch: os.arch(),
    cpuCount: os.cpus().length,
    memoryBytes: os.totalmem(),
    ...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
    ...(machineId ? { machineId } : {}),
  };
}

/**
 * Live load reading, sampled at call time — the on-demand counterpart to
 * {@link collectFederationHostInfo}'s static facts. Served by the
 * `backend.getLoadStatus` federation RPC and never gossiped. `loadAvg*`
 * are 0 on Windows (Node's `os.loadavg()` contract); `diskFreeBytes`
 * measures the volume holding the PwrAgent root and is omitted when the
 * read fails.
 */
export async function collectFederationLoadStatus(options?: {
  rootDir?: string;
}): Promise<FederationLoadStatus> {
  const rootDir = options?.rootDir ?? resolvePwragentRoot();
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
  let diskFreeBytes: number | undefined;
  try {
    const stats = await fs.statfs(rootDir);
    diskFreeBytes = stats.bavail * stats.bsize;
  } catch {
    diskFreeBytes = undefined;
  }
  const cpuCount = os.cpus().length;
  return {
    loadAvg1,
    loadAvg5,
    loadAvg15,
    ...(cpuCount > 0 ? { cpuCount } : {}),
    availableMemoryBytes: os.freemem(),
    ...(diskFreeBytes !== undefined ? { diskFreeBytes } : {}),
    sampledAt: Date.now(),
  };
}
