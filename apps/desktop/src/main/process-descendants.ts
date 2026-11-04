import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { buildPwrAgentChildProcessEnv } from "./child-process-env";

/**
 * POSIX process-table helpers for a child PwrAgent owns.
 *
 * Signalling a child's process group stops every member at once, but a
 * descendant that moved to its own group or session (an MCP server launched
 * through `npm exec`, a daemonizing helper) is not a member. These helpers
 * find such descendants before the stop and kill whichever survive it.
 */
export type ProcessTableEntry = { pid: number; ppid: number; command: string };

export type ProcessTableReader = () => Promise<ProcessTableEntry[] | undefined>;

const PS_TIMEOUT_MS = 5_000;
const PS_MAX_BUFFER = 32 * 1024 * 1024;

/** Every process on the machine, or `undefined` on Windows or failure. */
export const readProcessTable: ProcessTableReader = async () => {
  if (process.platform === "win32") return undefined;
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=,ppid=,command="],
      {
        encoding: "utf8",
        env: buildPwrAgentChildProcessEnv(process.env),
        maxBuffer: PS_MAX_BUFFER,
        timeout: PS_TIMEOUT_MS,
      },
      (error, output) => resolve(error ? undefined : output),
    );
  });
  return stdout === undefined ? undefined : parseProcessTable(stdout);
};

export function parseProcessTable(output: string): ProcessTableEntry[] {
  const entries: ProcessTableEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s?(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return entries;
}

/** Descendants of `rootPid`, nearest first. The root itself is excluded. */
export function collectDescendants(
  table: readonly ProcessTableEntry[],
  rootPid: number,
): ProcessTableEntry[] {
  const childrenByParent = new Map<number, ProcessTableEntry[]>();
  for (const entry of table) {
    const siblings = childrenByParent.get(entry.ppid);
    if (siblings) siblings.push(entry);
    else childrenByParent.set(entry.ppid, [entry]);
  }
  const found: ProcessTableEntry[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const child of childrenByParent.get(queue.shift()!) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Open descriptors of `pid` where the OS lists them cheaply (Linux). */
export async function countOpenFileDescriptors(pid: number): Promise<number | undefined> {
  if (process.platform !== "linux") return undefined;
  try {
    return (await readdir(`/proc/${pid}/fd`)).length;
  } catch {
    return undefined;
  }
}

export type ReapSurvivingDescendantsOptions = {
  readTable?: ProcessTableReader;
  signal?: (pid: number, signal: NodeJS.Signals) => void;
  gracefulTimeoutMs?: number;
  pollIntervalMs?: number;
};

/**
 * Stop the processes in `snapshot` that are still running. A pid counts only
 * when it still runs the command it ran in the snapshot, so a pid the OS
 * handed to an unrelated process in between is left alone. SIGTERM first,
 * then SIGKILL whatever outlives the grace period. Returns how many survived
 * the original stop.
 */
export async function reapSurvivingDescendants(
  snapshot: readonly ProcessTableEntry[],
  options: ReapSurvivingDescendantsOptions = {},
): Promise<number> {
  if (snapshot.length === 0) return 0;
  const readTable = options.readTable ?? readProcessTable;
  const signal = options.signal ?? ((pid, value) => process.kill(pid, value));
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 2_000;
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 100);
  const expected = new Map(snapshot.map((entry) => [entry.pid, entry.command]));
  const stillRunning = async (): Promise<number[]> => {
    const table = await readTable();
    if (!table) return [];
    return table
      .filter((entry) => expected.get(entry.pid) === entry.command)
      .map((entry) => entry.pid);
  };
  const send = (pids: readonly number[], value: NodeJS.Signals): void => {
    for (const pid of pids) {
      try {
        signal(pid, value);
      } catch {
        // Already gone, or not ours to signal.
      }
    }
  };

  const survivors = await stillRunning();
  if (survivors.length === 0) return 0;
  send(survivors, "SIGTERM");
  const deadline = Date.now() + gracefulTimeoutMs;
  let remaining = survivors;
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    remaining = await stillRunning();
  }
  send(remaining, "SIGKILL");
  return survivors.length;
}
