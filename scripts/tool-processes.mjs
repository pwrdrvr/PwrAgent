import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const DESCENDANT_ENV = "PWRAGENT_TOOL_DESCENDANT_TOKEN";
const psEnv = { ...process.env, LC_ALL: "C" };
// A cold powershell.exe start takes about 3 s on a GitHub Windows runner, so
// the 5 s budget the POSIX lookups use left no headroom there. The lookup is
// synchronous: a new lease holder makes two of them back to back before its
// 5 s heartbeat can run, and both together must finish inside the lease's
// 30 s stale window, or a waiter recovers a lease that is still in use.
export const WINDOWS_START_TIMEOUT_MS = 12_000;
let ownWindowsStartedAt;

// PwrGit compares this exact string: .NET UTC ticks from GetProcessTimes.
// WMI's CreationDate (wmic, CIM) stops at microseconds, so it cannot stand in.
function windowsStartedAt(pid) {
  if (pid === process.pid && ownWindowsStartedAt) return ownWindowsStartedAt;
  let stdout;
  try {
    stdout = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`],
    { encoding: "utf8", timeout: WINDOWS_START_TIMEOUT_MS, windowsHide: true });
  } catch (error) {
    // Killed while exiting: a newline-terminated answer was already complete.
    if (error.code !== "ETIMEDOUT" || !/^\d+\r?\n/.test(error.stdout ?? "")) throw error;
    stdout = error.stdout;
  }
  const startedAt = stdout.trim() || null;
  // Only our own PID is safe to remember; any other can be reused.
  if (pid === process.pid) ownWindowsStartedAt = startedAt;
  return startedAt;
}

export function processStartedAt(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid tool process identity");
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    }
    if (process.platform === "win32") return windowsStartedAt(pid);
    return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)],
      { encoding: "utf8", timeout: 5_000, env: psEnv }).trim() || null;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH" || error.status === 1) return null;
    throw error;
  }
}

export function ownerRunning(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); }
  catch (error) { if (error.code !== "EPERM") return false; }
  // A missing/unreadable identity never licenses cleanup of a live owner.
  if (!owner.ownerStartedAt) return true;
  try {
    const current = processStartedAt(owner.pid);
    return !current || current === owner.ownerStartedAt;
  } catch { return true; }
}

export function readPosixProcesses() {
  const rows = new Map();
  if (process.platform === "linux") {
    for (const name of readdirSync("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const text = readFileSync(`/proc/${name}/stat`, "utf8");
        const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        const pid = Number(name);
        rows.set(pid, { pid, parentPid: Number(fields[1]), groupPid: Number(fields[2]), state: fields[0], startedAt: fields[19] });
      } catch (error) {
        if (!["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) throw error;
      }
    }
  } else {
    const text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="],
      { encoding: "utf8", timeout: 5_000, env: psEnv });
    for (const line of text.trim().split("\n")) {
      const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!fields) throw new Error("Unable to read POSIX tool process identities");
      const pid = Number(fields[1]);
      rows.set(pid, { pid, parentPid: Number(fields[2]), groupPid: Number(fields[3]), state: fields[4], startedAt: fields[5].trim() });
    }
  }
  return rows;
}

function markedGroupLeaders(rows, token) {
  // The bridge grants a separate private capability to tools, not to its
  // launcher. This survives reparenting when a short-lived launcher exits
  // before observation. Copied public owner JSON alone grants no ownership.
  if (!token) return [];
  if (!/^[a-f0-9-]{36}$/.test(token)) return []; // Legacy leases had no descendant capability.
  const marker = `${DESCENDANT_ENV}=${token}`;
  if (process.platform === "linux") {
    return [...rows.values()].filter((row) => {
      if (row.pid !== row.groupPid || row.state.startsWith("Z")) return false;
      try {
        return readFileSync(`/proc/${row.pid}/environ`, "utf8").split("\0").includes(marker)
          && processStartedAt(row.pid) === row.startedAt;
      } catch (error) {
        if (["ENOENT", "ESRCH", "EACCES", "EPERM"].includes(error.code)) return false;
        throw error;
      }
    });
  }
  let text;
  try {
    text = execFileSync("ps", ["eww", "-axo", "pid=,command="], {
      encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 ** 2, env: psEnv,
    });
  } catch { throw new Error("Unable to inspect POSIX tool descendant capabilities"); }
  const marked = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const row = rows.get(Number(fields[0]));
    if (row && row.pid === row.groupPid && !row.state.startsWith("Z") && fields.slice(1).includes(marker)
      && processStartedAt(row.pid) === row.startedAt) marked.push(row);
  }
  return marked;
}

function checkedGroup(group) {
  if (!Number.isInteger(group?.pid) || group.pid <= 0 || typeof group.startedAt !== "string" || !group.startedAt) {
    throw new Error("Missing tool process group start identity; refusing unsafe cleanup");
  }
  return { pid: group.pid, startedAt: group.startedAt };
}

function send(pid, signal) {
  try { process.kill(pid, signal); }
  catch (error) {
    if (error.code === "ESRCH") return;
    // macOS answers EPERM, not ESRCH, for a group whose only members are
    // unreaped zombies. A stopped parent cannot reap them, so drain would
    // otherwise retry the same EPERM forever.
    if (error.code === "EPERM" && pid < 0
      && ![...readPosixProcesses().values()].some((row) => row.groupPid === -pid && !row.state.startsWith("Z"))) return;
    throw error;
  }
}

// Only groups whose leaders were proven descendants are added. Remembering
// their start identities preserves ownership after the original parent exits.
export function createPosixProcessTracker(primary, descendantGroups = [], { descendantToken } = {}) {
  primary = checkedGroup(primary);
  const groups = new Map([primary, ...descendantGroups].map((group) => {
    const checked = checkedGroup(group);
    return [checked.pid, checked];
  }));

  function observe() {
    const rows = readPosixProcesses();
    const owned = new Set();
    for (const row of markedGroupLeaders(rows, descendantToken)) {
      if (!groups.has(row.pid)) groups.set(row.pid, checkedGroup({ pid: row.pid, startedAt: row.startedAt }));
    }
    for (const [pid, group] of groups) {
      const leader = rows.get(pid);
      if (leader && leader.startedAt !== group.startedAt) {
        groups.delete(pid); // Its PID/PGID now belongs to somebody else.
        continue;
      }
      for (const row of rows.values()) if (row.groupPid === pid) owned.add(row.pid);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows.values()) {
        if (!owned.has(row.pid) && owned.has(row.parentPid)) { owned.add(row.pid); changed = true; }
      }
    }
    for (const pid of owned) {
      const row = rows.get(pid);
      if (groups.has(row.groupPid)) continue;
      const leader = rows.get(row.groupPid);
      if (leader && owned.has(leader.pid)) groups.set(leader.pid, checkedGroup({ pid: leader.pid, startedAt: leader.startedAt }));
    }
    return { rows, owned };
  }

  function recordedGroups() {
    return [...groups.values()].filter((group) => group.pid !== primary.pid).sort((a, b) => a.pid - b.pid);
  }

  function signal(signal) {
    const { rows } = observe();
    // Escaped groups first; keep their parents alive until they are signalled.
    for (const group of [...recordedGroups(), ...(groups.has(primary.pid) ? [primary] : [])]) {
      const current = processStartedAt(group.pid);
      if (current && current !== group.startedAt) continue;
      if (group.pid === process.pid) {
        // The bridge must stay alive to drain detached groups on owner death.
        for (const row of rows.values()) {
          if (row.groupPid === group.pid && row.pid !== process.pid && !row.state.startsWith("Z")
            && processStartedAt(row.pid) === row.startedAt) send(row.pid, signal);
        }
      } else send(-group.pid, signal);
    }
  }

  async function drain() {
    // Freeze parents before the last ancestry snapshot so they cannot fork
    // another detached group between discovery and the final SIGKILL.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      observe();
      const before = JSON.stringify(recordedGroups());
      signal("SIGSTOP");
      observe();
      if (JSON.stringify(recordedGroups()) !== before) continue;
      signal("SIGKILL");
      const { rows, owned } = observe();
      const running = [...owned].some((pid) => {
        const row = rows.get(pid);
        // ps itself can appear in a macOS bridge snapshot but has exited by
        // the time execFileSync returns. Check identity before counting it.
        return pid !== process.pid && !row.state.startsWith("Z") && processStartedAt(pid) === row.startedAt;
      });
      if (!running) return;
      await delay(50);
    }
    throw new Error("Tool descendants are still running; refusing to release their lease");
  }

  return { observe, recordedGroups, signal, drain };
}
