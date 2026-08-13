import { execFile } from "node:child_process";

/**
 * Whether `pid` is still running.
 *
 * `EPERM` means the process exists but is not ours to signal, so it counts as
 * alive. Treating it as gone would race cleanup against a live writer.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function collectDescendantPids(
  rootPid: number,
  processTable: string,
): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const line of processTable.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    const childPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const children = childrenByParent.get(parentPid);
    if (children) {
      children.push(childPid);
    } else {
      childrenByParent.set(parentPid, [childPid]);
    }
  }

  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parentPid = queue.shift();
    if (parentPid === undefined) {
      break;
    }
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      descendants.push(childPid);
      queue.push(childPid);
    }
  }
  return descendants;
}

/**
 * Snapshot a POSIX process tree while its root still exists. Windows has no
 * `ps`; resolving an empty output keeps the caller's watch set limited to the
 * known marker pid there.
 */
export async function listDescendantPids(rootPid: number): Promise<number[]> {
  const stdout = await new Promise<string>((resolve) => {
    execFile(
      "ps",
      ["-axo", "pid=,ppid="],
      { timeout: 5_000 },
      (_error, output) => resolve(output ?? ""),
    );
  });
  return collectDescendantPids(rootPid, stdout);
}

/** Wait until every watched pid exits or the bounded polling window expires. */
export async function waitForPidsToExit(
  pids: Iterable<number>,
  timeoutMs: number,
  pollMs: number,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = [...pids].filter(isPidAlive);
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    remaining = remaining.filter(isPidAlive);
  }
  return remaining;
}
