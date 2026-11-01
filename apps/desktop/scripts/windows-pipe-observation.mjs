import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function normalizePipeName(name) {
  if (typeof name !== "string") return undefined;
  const nodePrefix = "\\\\?\\pipe\\";
  const nativePrefix = "\\Device\\NamedPipe\\";
  if (name.startsWith(nodePrefix)) return nativePrefix + name.slice(nodePrefix.length);
  return name.startsWith(nativePrefix) ? name : undefined;
}

export function exactLauncherPipes(candidates, inventory) {
  if (!inventory?.verified || !inventory.liveAfter) {
    return { error: "Live main name inventory was not identity-verified." };
  }
  const pool = new Set(candidates.map(normalizePipeName).filter(Boolean));
  const matches = (inventory.pipes ?? []).filter(({ name }) => pool.has(name));
  const names = [...new Set(matches.map(({ name }) => name))];

  return names.length === 4
    ? { names }
    : { error: "Main inventory did not narrow the candidate pool to exactly four complete names.", matchedNameCount: names.length };
}

// A sampled disappearance time never substitutes for the native exit FILETIME.
export function ancestry(rows, pid, created) {
  const chain = [];
  const visited = new Set();
  let current = rows.get(pid + ":" + created);
  if (!current) return { status: "unobserved-process", chain };
  for (;;) {
    const key = current.pid + ":" + current.created;
    if (visited.has(key)) return { status: "cycle", chain };
    visited.add(key);
    chain.push(current);
    if (!current.ppid) return { status: "complete", chain };
    if (chain.length >= 64) return { status: "depth-limit", chain };
    const observedParent = current.parentCreated ? rows.get(current.ppid + ":" + current.parentCreated) : undefined;
    const parents = current.parentCreated
      ? (observedParent && BigInt(observedParent.created) <= BigInt(current.created) ? [observedParent] : [])
      : [...rows.values()].filter((row) => {
        if (row.pid !== current.ppid || BigInt(row.created) > BigInt(current.created)) return false;
        return row.nativeExit && BigInt(row.nativeExit) > 0n && BigInt(current.created) <= BigInt(row.nativeExit);
      });
    if (parents.length !== 1) return { status: parents.length ? "ambiguous-parent" : "missing-parent", chain };
    current = parents[0];
  }
}

export function observeWindowsLauncher(child, { directory, logEvidence, now = Date.now, report = () => process.report.getReport() } = {}) {
  if (!directory || path.basename(child.spawnfile).toLowerCase() !== "electron.exe") return;
  const launchId = randomUUID();
  const flags = () => child.stdio.flatMap((stream, fd) => stream && fd >= 1 && fd <= 4 ? [{
    fd, destroyed: stream.destroyed, readableEnded: stream.readableEnded, writableFinished: stream.writableFinished,
  }] : []);
  const request = (kind, data) => {
    const filename = path.join(directory, launchId + "-" + kind);
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(filename + ".tmp", JSON.stringify({ kind, launchId, workerPid: process.pid, pid: child.pid, ...data }));
      renameSync(filename + ".tmp", filename + ".json");
    } catch (error) {
      logEvidence?.("windows-pipe-request-error", { launchId, workerPid: process.pid, kind, error: error.message });
    }
  };
  child.once("exit", (code, signal) => {
    // These are the callback's entry time and flags, before any report or I/O.
    const at = now();
    const stdio = flags();
    if (code !== 0 || stdio.length !== 4 || !stdio.every((stream) => !stream.destroyed && !stream.readableEnded)) return;
    const trigger = { at, code, signal, stdio };
    // Preserve the original trigger even when the controller/query never finishes.
    logEvidence?.("windows-natural-exit-open-pipes", { launchId, workerPid: process.pid, pid: child.pid, ...trigger });
    request("trigger", trigger);
  });
  try {
    const at = now();
    const stdio = flags();
    // Launch is the sole synchronous report. The native main's inventory narrows
    // this worker-wide candidate pool; a worker-PID suffix is never a mapping.
    const candidates = report().libuv.flatMap((handle) => handle.type === "pipe"
      ? [handle.localEndpoint, handle.remoteEndpoint].filter((name) => typeof name === "string"
        && name.endsWith("-" + process.pid) && normalizePipeName(name)?.includes("\\uv\\"))
      : []);
    request("launch", { at, stdio, candidates: [...new Set(candidates)].slice(0, 256), omittedCandidates: Math.max(0, candidates.length - 256) });
  } catch (error) {
    logEvidence?.("windows-pipe-launch-error", { launchId, workerPid: process.pid, pid: child.pid, error: error.message });
  }
  return launchId;
}

// File-only Handle inventories can omit named pipes. Keep every query (including
// the controlled native probe) on the same all-handle invocation.
export const HANDLE_INVENTORY_OPTIONS = Object.freeze(["-accepteula", "-nobanner", "-a"]);

export function parseHandleOutput(output, defaultPid, query = {}) {
  const processes = new Map();
  const errors = [];
  let errorCount = 0, recognizedHandleCount = 0, unrecognizedLineCount = 0;
  let usage = false, explicitEmpty = false;
  let current = defaultPid ? { pid: defaultPid, pipes: [] } : undefined;
  const get = (pid) => {
    if (!processes.has(pid)) processes.set(pid, { pid, pipes: [] });
    return processes.get(pid);
  };
  const recordError = (reason) => {
    errorCount++;
    // Error lines can contain unrelated names, paths or account information.
    if (errors.length < 8) errors.push(reason);
  };
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim()) continue;
    if (/^\s*usage:/i.test(line)) { usage = true; continue; }
    if (/^\s*No matching handles found\.\s*$/i.test(line)) { explicitEmpty = true; continue; }
    // Search mode is one process/handle per line. Scoped -nobanner dumps omit
    // the process header; only the bracketed native identity supplies that PID.
    const search = line.match(/\bpid:\s*(\d+)\s+(?:type:\s+File\s+)?([a-f0-9]+):\s+(\\Device\\NamedPipe\\uv\\[^\r\n]+)$/i);
    if (search) {
      get(Number(search[1])).pipes.push({ handle: search[2].toLowerCase(), name: search[3] });
      recognizedHandleCount++;
      continue;
    }
    const header = line.match(/^.+?\s+pid:\s*(\d+)\s*$/i);
    if (header) { current = get(Number(header[1])); continue; }
    const pipe = line.match(/^\s*([a-f0-9]+):\s+(?:File\s+(?:\([^)]*\)\s+)?)?(\\Device\\NamedPipe\\uv\\[^\r\n]+)$/i);
    if (pipe && current) {
      current = get(current.pid);
      current.pipes.push({ handle: pipe[1].toLowerCase(), name: pipe[2] });
      recognizedHandleCount++;
      continue;
    }
    // Recognize non-pipe records without retaining their names. A malformed uv
    // record must not turn into a successful inventory with zero named pipes.
    const scopedRecord = /^\s*[a-f0-9]+:\s+(?:[a-z][\w]*|<Unknown type>)(?:\s.*)?$/i.test(line);
    const searchRecord = line.match(/^.+?\s+pid:\s*(\d+)\s+type:\s+\S+\s+[a-f0-9]+:(?:\s.*)?$/i);
    if (!/\\Device\\NamedPipe\\uv\\/i.test(line) && ((scopedRecord && current) || searchRecord)) {
      get(searchRecord ? Number(searchRecord[1]) : current.pid);
      recognizedHandleCount++;
      continue;
    }
    if (/access (?:is )?denied/i.test(line)) recordError("access-denied");
    else if (/administrat(?:or|ive)|requires? elevation/i.test(line)) recordError("privilege-required");
    else if (/\berror\b|unable to|could not|invalid (?:argument|option|parameter)|unknown (?:option|parameter)/i.test(line)) recordError("query-rejected");
    else if (!/^-{3,}\s*$|^(?:Nthandle|Handle) v[\d.]+ - Handle viewer\s*$|^Copyright \(C\) |^Sysinternals - /i.test(line)) unrecognizedLineCount++;
  }
  // Handle 5.0 returns exit 1 for its explicit, otherwise clean no-match result.
  // A timeout, signal, stderr, or any other unsuccessful exit is not emptiness.
  const cleanEmpty = explicitEmpty && !recognizedHandleCount && !processes.size && !unrecognizedLineCount && !errorCount;
  const executionFailed = query.stderrBytes > 0 || (query.error
    && !(cleanEmpty && query.error.code === 1 && !query.error.killed && !query.error.signal));
  const status = usage ? "usage"
    : executionFailed || errorCount ? "query-failed"
    : unrecognizedLineCount || (explicitEmpty && !cleanEmpty) ? "unrecognized"
    : recognizedHandleCount ? "inventory"
    : cleanEmpty ? "empty" : "unrecognized";
  return { status, recognizedHandleCount, unrecognizedLineCount,
    processes: [...processes.values()], errors, errorCount, omittedErrors: errorCount - errors.length };
}

export function bindPipeNames(before, after, output, query) {
  const parsed = parseHandleOutput(output, before?.pid, query);
  const details = { nameQueryStatus: parsed.status, parsedProcessCount: parsed.processes.length,
    recognizedHandleCount: parsed.recognizedHandleCount, unrecognizedLineCount: parsed.unrecognizedLineCount,
    nameQueryErrors: parsed.errors, nameQueryErrorCount: parsed.errorCount, omittedNameQueryErrors: parsed.omittedErrors };
  if (!before?.verified || !after?.verified || !before.liveAfter || !after.liveAfter
    || before.pid !== after.pid || before.created !== after.created) {
    return { ...details, error: "Source creation identity was not verified around the name inventory." };
  }
  if (parsed.status !== "inventory" && parsed.status !== "empty") {
    return { ...details, error: "Name inventory was unavailable: " + parsed.status + "." };
  }
  if (parsed.processes.some((entry) => entry.pid !== before.pid)) {
    return { ...details, error: "Unexpected PID in the scoped name inventory.", observedPids: parsed.processes.slice(0, 8).map((entry) => entry.pid) };
  }
  const source = parsed.processes.find((entry) => entry.pid === before.pid);
  return { ...after, ...details, pipes: source?.pipes ?? [] };
}

export function packageManagerCommand(pnpm, args) {
  if (!pnpm || !path.isAbsolute(pnpm) || /\.(?:cmd|bat)$/i.test(pnpm)) {
    throw new Error("Run this controller through a pnpm JavaScript entry point or native executable.");
  }
  return /\.exe$/i.test(pnpm)
    ? { file: pnpm, args }
    : { file: process.execPath, args: [pnpm, ...args] };
}
