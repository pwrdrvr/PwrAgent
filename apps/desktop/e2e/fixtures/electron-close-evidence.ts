import type { ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync, opendirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const observers = new WeakMap<ChildProcess, ReturnType<typeof observe>>();
const LIMITS = { elapsedMs: 750, processes: 4096, descriptors: 32768, perProcess: 512, members: 256, holders: 128 };
const EXECUTABLE_CLASSES = new Set(["electron", "pwragent", "node", "chrome_crashpad_handler", "git", "bash", "sh", "dash", "sleep", "dbus-daemon"]);
type Identity = { pid: number; ppid: number; pgid: number; session: number; startTicks: string; state: string };
type Endpoint = { stdio: number; side: "launcher" | "worker"; target: string };

/** Call while the launcher is alive: socketpair peers have different inodes. */
export function observeElectronLauncher(child: ChildProcess): void {
  if (!observers.has(child)) observers.set(child, observe(child));
}

function observe(child: ChildProcess) {
  let exitObserved = child.exitCode !== null || child.signalCode !== null;
  let closeObserved = false;
  const observationStartedAt = new Date().toISOString();
  child.once?.("exit", () => { exitObserved = true; });
  child.once?.("close", () => { closeObserved = true; });
  const endpoints: Endpoint[] = [];
  const initialIdentity = process.platform === "linux" && !exitObserved ? identity(child.pid) : undefined;
  if (process.platform === "linux") {
    for (const [stdio, stream] of (child.stdio ?? []).entries()) {
      if (stdio >= 12) break;
      const target = exitObserved ? undefined : descriptor(child.pid, stdio);
      if (target) endpoints.push({ stdio, side: "launcher", target });
      // Node exposes no public descriptor getter for its pipe/socket streams.
      // Inspect only this numeric handle field, never the stream/report object.
      const fd = (stream as unknown as { _handle?: { fd?: number } } | null)?._handle?.fd;
      const peer = descriptor(process.pid, fd);
      if (peer) endpoints.push({ stdio, side: "worker", target: peer });
    }
  }
  return () => ({
    observationStartedAt, exitObserved, closeObserved,
    launcherPid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
    killed: child.killed, initialIdentity, endpoints,
    stdio: (child.stdio ?? []).slice(0, 12).map((stream, fd) => {
      const state = stream as unknown as Record<string, unknown> | null;
      const flag = (key: string) => typeof state?.[key] === "boolean" ? state[key] : undefined;
      return { fd, present: Boolean(stream), destroyed: flag("destroyed"), closed: flag("closed"), readableEnded: flag("readableEnded"), writableFinished: flag("writableFinished") };
    }),
  });
}

/** Synchronous and budgeted: persist evidence before any forced signal. */
export function captureElectronCloseEvidence(params: {
  child: ChildProcess;
  diagnosticsFile?: string;
  launchId?: string;
  reason: "timeout" | "rejected";
}): void {
  try {
    observeElectronLauncher(params.child);
    const launcher = observers.get(params.child)!();
    const snapshot = {
      schemaVersion: 1, kind: "owning-test-close-deadline", time: new Date().toISOString(),
      launchId: /^[a-zA-Z0-9-]{1,80}$/.test(params.launchId ?? "") ? params.launchId : "untracked",
      reason: params.reason, workerPid: process.pid, launcher,
      linux: linuxEvidence(launcher.launcherPid, launcher.endpoints),
    };
    const line = `${JSON.stringify(snapshot)}\n`;
    if (params.diagnosticsFile) {
      mkdirSync(path.dirname(params.diagnosticsFile), { recursive: true });
      appendFileSync(params.diagnosticsFile, line, "utf8");
    } else {
      process.stderr.write(`[pwragent-e2e-close-evidence] ${line}`);
    }
  } catch {
    // Do not serialize OS error messages: they can include arbitrary paths.
    try { process.stderr.write("[pwragent-e2e-close-evidence] capture unavailable\n"); } catch { /* Closed worker output. */ }
  }
}

function linuxEvidence(pid: number | undefined, endpoints: Endpoint[]) {
  if (process.platform !== "linux") return { status: "unsupported" };
  try { return scanLinux(pid, endpoints); } catch { return { status: "unavailable" }; }
}

function descriptor(pid: number | undefined, fd: number | undefined): string | undefined {
  if (!pid || fd === undefined || fd < 0) return undefined;
  try {
    const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
    return /^(pipe|socket):\[\d+\]$/.test(target) ? target : undefined;
  } catch { return undefined; }
}

function identity(pid: number | undefined): Identity | undefined {
  if (!pid) return undefined;
  try {
    // comm may contain spaces or parentheses; never emit it or command lines.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(fields[1]), pgid: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19], state: fields[0] };
  } catch { return undefined; }
}

function executableClass(pid: number): string {
  try {
    const name = path.basename(readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, "")).toLowerCase();
    return EXECUTABLE_CLASSES.has(name) ? name : "other";
  } catch { return "unavailable"; }
}

function scanLinux(launcherPid: number | undefined, endpoints: Endpoint[]) {
  const started = performance.now();
  const expired = () => performance.now() - started >= LIMITS.elapsedMs;
  const rows: Identity[] = [];
  const members: Array<Identity & { executableClass: string }> = [];
  const holders: Array<Identity & { executableClass: string; fd: number; target: string; stdio: number[]; sides: string[]; accessMode?: number }> = [];
  const targets = new Set(endpoints.map(({ target }) => target));
  let processesVisited = 0;
  let descriptorsVisited = 0;
  let fdDirectoriesVisited = 0;
  let inaccessibleFdDirectories = 0;
  let identityRaces = 0;
  let descriptorRaces = 0;
  let capped = false;
  const proc = opendirSync("/proc");
  try {
    let entry;
    while ((entry = proc.readSync())) {
      if (!/^\d+$/.test(entry.name)) continue;
      if (expired() || processesVisited >= LIMITS.processes) { capped = true; break; }
      processesVisited++;
      const row = identity(Number(entry.name));
      if (row) rows.push(row);
      else identityRaces++;
    }
  } finally { proc.closeSync(); }
  // Scan the dedicated group first, including reparented orphans. Then inspect
  // all visible processes: an inherited holder may have changed its group.
  rows.sort((a, b) => Number(b.pgid === launcherPid) - Number(a.pgid === launcherPid));
  for (const row of rows) {
    if (expired()) { capped = true; break; }
    if (row.pgid === launcherPid) {
      if (members.length < LIMITS.members) members.push({ ...row, executableClass: executableClass(row.pid) });
      else capped = true;
    }
  }
  for (const row of rows) {
    if (expired() || descriptorsVisited >= LIMITS.descriptors) { capped = true; break; }
    // Without a sampled endpoint, no descriptor ownership can be established.
    if (!targets.size) break;
    let directory;
    try { directory = opendirSync(`/proc/${row.pid}/fd`); } catch { inaccessibleFdDirectories++; continue; }
    fdDirectoriesVisited++;
    const matches: typeof holders = [];
    try {
      let entry;
      let count = 0;
      while ((entry = directory.readSync())) {
        if (expired() || count >= LIMITS.perProcess || descriptorsVisited >= LIMITS.descriptors) { capped = true; break; }
        count++;
        descriptorsVisited++;
        let target;
        try { target = readlinkSync(`/proc/${row.pid}/fd/${entry.name}`); } catch { descriptorRaces++; continue; }
        if (!targets.has(target)) continue;
        if (holders.length + matches.length >= LIMITS.holders) { capped = true; continue; }
        const matching = endpoints.filter((endpoint) => endpoint.target === target);
        let accessMode;
        try {
          const flags = readFileSync(`/proc/${row.pid}/fdinfo/${entry.name}`, "utf8").match(/^flags:\s+([0-7]+)/m)?.[1];
          if (flags) accessMode = parseInt(flags, 8) & 3;
        } catch { /* Holder identity is still useful without fdinfo permission. */ }
        matches.push({ ...row, executableClass: executableClass(row.pid), fd: Number(entry.name), target, accessMode, stdio: [...new Set(matching.map(({ stdio }) => stdio))], sides: [...new Set(matching.map(({ side }) => side))] });
      }
    } finally { directory.closeSync(); }
    // Avoid attributing an fd to a reused PID during the scan.
    if (matches.length && identity(row.pid)?.startTicks !== row.startTicks) identityRaces++;
    else holders.push(...matches);
  }
  return {
    status: capped ? "partial" : "complete", elapsedMs: Math.round(performance.now() - started), limits: LIMITS,
    processesVisited, fdDirectoriesVisited, descriptorsVisited, inaccessibleFdDirectories, identityRaces, descriptorRaces,
    endpointStatus: endpoints.some(({ side }) => side === "launcher") ? "sampled" : "launcher-endpoints-unavailable",
    members, holders,
  };
}
