import { spawnSync } from "node:child_process";
import { buildPwrAgentChildProcessEnv } from "./child-process-env";

type WindowsProcess = {
  pid: number;
  ppid: number;
  created: string;
};

/** A single process-table observation, never a walk across changing CIM results. */
export function windowsProcessTreeIds(output: string, rootPid: number): number[] {
  const parsed: unknown = JSON.parse(output || "[]");
  const rows: WindowsProcess[] = [];
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof row !== "object" || row === null) continue;
    const { pid, ppid, created } = row as Partial<WindowsProcess>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0
      || typeof ppid !== "number" || !Number.isInteger(ppid) || ppid < 0
      || typeof created !== "string" || !/^\d+$/.test(created)) continue;
    rows.push({ pid, ppid, created });
  }
  const processes = new Map(rows.map((row) => [row.pid, row]));
  const root = processes.get(rootPid);
  if (!root) return [rootPid];
  const children = new Map<number, WindowsProcess[]>();
  for (const row of rows) {
    const parent = processes.get(row.ppid);
    // A surviving child can retain a parent PID already reused by a newer
    // process. It does not belong to that newer process's tree.
    if (!parent || BigInt(row.created) < BigInt(parent.created)) continue;
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const found = new Set([rootPid]);
  const queue = [rootPid];
  for (const pid of queue) {
    for (const child of children.get(pid) ?? []) {
      if (found.has(child.pid)) continue;
      found.add(child.pid);
      queue.push(child.pid);
    }
  }
  return [...found];
}

export function snapshotWindowsProcessTreeIds(powerShell: string, rootPid: number): number[] {
  const result = spawnSync(powerShell, [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
    "Get-CimInstance Win32_Process | Select-Object @{n='pid';e={$_.ProcessId}},"
      + "@{n='ppid';e={$_.ParentProcessId}},"
      + "@{n='created';e={$_.CreationDate.ToFileTimeUtc().ToString()}} | ConvertTo-Json -Compress",
  ], {
    encoding: "utf8",
    env: buildPwrAgentChildProcessEnv(process.env),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
    windowsHide: true,
  });
  if (result.status !== 0) return [rootPid];
  try {
    return windowsProcessTreeIds(String(result.stdout ?? ""), rootPid);
  } catch {
    return [rootPid];
  }
}
