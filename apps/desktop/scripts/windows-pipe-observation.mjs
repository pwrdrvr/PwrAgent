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

export function parseHandleOutput(output, defaultPid) {
  const processes = new Map();
  const errors = [];
  let errorCount = 0;
  let current = defaultPid ? { pid: defaultPid, pipes: [] } : undefined;
  const get = (pid) => {
    if (!processes.has(pid)) processes.set(pid, { pid, pipes: [] });
    return processes.get(pid);
  };
  for (const line of output.split("\n")) {
    // Search mode is one process/handle per line. A scoped numeric -p dump
    // omits the header entirely; its PID is supplied by the bracketed query.
    // File-only mode can also omit the redundant File/type column.
    const search = line.match(/\bpid:\s*(\d+)\s+(?:type:\s+File\s+)?([a-f0-9]+):\s+(\\Device\\NamedPipe\\uv\\[^\r\n]+)\r?$/i);
    if (search) {
      get(Number(search[1])).pipes.push({ handle: search[2].toLowerCase(), name: search[3] });
      continue;
    }
    const header = line.match(/\bpid:\s*(\d+)\b/);
    if (header) { current = get(Number(header[1])); continue; }
    const pipe = line.match(/^\s*([a-f0-9]+):\s+(?:File\s+(?:\([^)]*\)\s+)?)?(\\Device\\NamedPipe\\uv\\[^\r\n]+)\r?$/i);
    if (pipe && current) {
      current = get(current.pid);
      current.pipes.push({ handle: pipe[1].toLowerCase(), name: pipe[2] });
    }
    if (/\berror\b|access denied|unable to|could not/i.test(line)) {
      errorCount++;
      if (errors.length < 8) errors.push(line.slice(0, 256));
    }
  }
  return { processes: [...processes.values()], errors, errorCount, omittedErrors: errorCount - errors.length };
}

export function bindPipeNames(before, after, output) {
  const parsed = parseHandleOutput(output, before?.pid);
  const source = parsed.processes.find((entry) => entry.pid === before?.pid);
  if (!before?.verified || !after?.verified || !before.liveAfter || !after.liveAfter
    || before.pid !== after.pid || before.created !== after.created) {
    return { error: "Source creation identity was not verified around the name inventory." };
  }
  if (parsed.processes.some((entry) => entry.pid !== before.pid)) {
    return { error: "Unexpected PID in the scoped name inventory.", observedPids: parsed.processes.slice(0, 8).map((entry) => entry.pid) };
  }
  return { ...after, pipes: source?.pipes ?? [], parsedProcessCount: parsed.processes.length, nameQueryErrors: parsed.errors, nameQueryErrorCount: parsed.errorCount, omittedNameQueryErrors: parsed.omittedErrors };
}

export function packageManagerCommand(pnpm, args) {
  if (!pnpm || !path.isAbsolute(pnpm) || /\.(?:cmd|bat)$/i.test(pnpm)) {
    throw new Error("Run this controller through a pnpm JavaScript entry point or native executable.");
  }
  return /\.exe$/i.test(pnpm)
    ? { file: pnpm, args }
    : { file: process.execPath, args: [pnpm, ...args] };
}
