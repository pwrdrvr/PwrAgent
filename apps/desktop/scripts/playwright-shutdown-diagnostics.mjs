import { createHook } from "node:async_hooks";
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const key = Symbol.for("pwragent.playwrightShutdownDiagnostics");
const require = createRequire(import.meta.url);
const fromPlaywright = createRequire(require.resolve("@playwright/test"));
const { utils } = fromPlaywright("playwright-core/lib/coreBundle");
const playwrightGlobals = fromPlaywright(path.join(path.dirname(fromPlaywright.resolve("playwright/package.json")), "lib/globals.js"));
const trackedTypes = new Set([
  "PROCESSWRAP", "PIPEWRAP", "TCPWRAP", "TCPSERVERWRAP", "Timeout",
  "FSREQCALLBACK", "FSREQPROMISE", "GETADDRINFOREQWRAP", "UDPWRAP",
]);

// Called while Playwright loads its config in the worker, before tests launch
// anything. The two versioned pnpm patches only emit observations; they do
// not replace promises, adjust deadlines, swallow errors, or kill processes.
export function installShutdownDiagnostics({ outputDir, currentTest, captureAfterMs = 5_000 }) {
  if (!playwrightGlobals.isWorkerProcess()
    || process.env.PWRAGENT_E2E_WORKER_DIAGNOSTICS === "0"
    || globalThis[key]) return;

  const directory = path.resolve(outputDir, "worker-shutdown", `worker-${process.env.TEST_WORKER_INDEX}-${process.pid}`);
  const processes = new Map();
  const resources = new Map();
  let droppedResources = 0;
  let phase;
  let timer;
  let captures = 0;
  let observing = false;
  let treeStarted = false;

  const safe = (fn) => (...args) => {
    try { return fn(...args); } catch (error) {
      // Diagnostics must not turn a successful cleanup into a failure.
      // A missing artifact is explicitly reported, never called a clean run.
      try { process.stderr.write(`[worker-shutdown] capture failed: ${error.message}\n`); } catch { /* Worker stdio may already be closed. */ }
    }
  };
  const write = (file, data) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, file), JSON.stringify(data, null, 2));
  };
  const event = (data) => {
    mkdirSync(directory, { recursive: true });
    appendFileSync(path.join(directory, "timeline.jsonl"), `${JSON.stringify({ time: new Date().toISOString(), ...data })}\n`);
  };
  const testOwner = () => {
    try {
      const info = currentTest();
      return { title: info.title, file: info.file, line: info.line, retry: info.retry };
    } catch { return undefined; }
  };
  const stack = () => new Error().stack?.split("\n").slice(2, 16).join("\n");
  const hook = createHook({
    init(id, type, triggerId, resource) {
      if (observing || !trackedTypes.has(type)) return;
      if (resources.size >= 512) { droppedResources++; return; }
      resources.set(id, { type, triggerId, owner: testOwner(), stack: stack(), resource: new WeakRef(resource) });
    },
    destroy(id) { resources.delete(id); },
  });
  hook.enable();
  // This is the worker-side readiness boundary. The config module also runs in
  // Playwright's controller, which may inherit TEST_WORKER_INDEX but returns
  // above because Playwright has not marked it as a worker. A timeline proves the
  // worker loaded the recorder before its test body or cleanup starts.
  safe(() => event({ kind: "worker-start", workerIndex: process.env.TEST_WORKER_INDEX }))();

  const captureTree = () => {
    if (treeStarted) return;
    treeStarted = true;
    // No command lines or environment: process identity and ancestry suffice
    // to find surviving children without uploading CI credentials.
    const windows = process.platform === "win32";
    const command = windows ? "powershell.exe" : "ps";
    const args = windows
      ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"]
      : ["-axo", "pid=,ppid=,comm="];
    const timeoutMs = 3_000;
    const started = Date.now();
    let child;
    const finish = (data) => {
      write("process-tree.json", { workerPid: process.pid, elapsedMs: Date.now() - started, timeoutMs, ...data });
      process.removeListener("exit", interrupted);
    };
    const interrupted = safe((workerExitCode) => {
      // Playwright explicitly exits its worker; neither an unref'ed query nor
      // its callback owns that deadline. Preserve the incomplete observation
      // synchronously and stop our query instead of leaving an orphan behind.
      try { child?.kill(); } finally {
        finish({ status: "interrupted", reason: "worker-exit", workerExitCode, queryPid: child?.pid });
      }
    });
    write("process-tree.json", { status: "pending", workerPid: process.pid, timeoutMs });
    process.once("exit", interrupted);
    child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, safe((error, stdout, stderr) => {
      if (error) {
        // Node words a timeout kill and a silent non-zero exit identically
        // ("Command failed: <command>"), so the message alone cannot say which.
        finish({
          error: error.message, killed: error.killed, signal: error.signal, code: error.code,
          stderr: String(stderr).slice(0, 2048), stdoutBytes: stdout.length,
        });
        return;
      }
      const rows = windows
        ? [].concat(JSON.parse(stdout)).map((row) => ({ pid: row.ProcessId, ppid: row.ParentProcessId, name: row.Name }))
        : stdout.trim().split("\n").map((line) => {
          const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
          return match && { pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(match[3]) };
        }).filter(Boolean);
      const owned = new Set([process.pid, ...[...processes.values()].map(({ child }) => child.pid)]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const row of rows) {
          if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
        }
      }
      finish({ processes: rows.filter((row) => owned.has(row.pid)) });
    }));
    child.unref();
    child.stdout?.unref?.();
    child.stderr?.unref?.();
  };

  const capture = safe((reason) => {
    if (captures >= 3) return;
    observing = true;
    try {
      const registered = [...utils.gracefullyCloseSet];
      const report = process.report.getReport();
      const filename = `snapshot-${++captures}.json`;
      write(filename, {
        reason, phase, workerPid: process.pid, time: new Date().toISOString(),
        registeredClosers: registered.map((close) => ({ name: close.name, pid: processes.get(close)?.child.pid })),
        processes: [...processes.entries()].map(([close, record]) => ({
          ...record.details,
          registered: registered.includes(close),
          exitCode: record.child.exitCode, signalCode: record.child.signalCode,
          stdio: record.child.stdio.map((stream, fd) => stream && ({ fd, destroyed: stream.destroyed, readableEnded: stream.readableEnded, writableFinished: stream.writableFinished })).filter(Boolean),
        })),
        // Supporting evidence, not a claim that every live handle is a leak.
        activeResources: process.getActiveResourcesInfo(),
        resources: [...resources.entries()].flatMap(([id, { resource, ...details }]) => {
          const value = resource.deref();
          return !value || value.hasRef?.() === false ? [] : [{ id, ...details }];
        }),
        droppedResources,
        // Do not write the raw report: it includes environment variables and
        // command-line arguments. These sections contain the useful waits.
        report: { javascriptStack: report.javascriptStack, nativeStack: report.nativeStack, libuv: report.libuv, resourceUsage: report.resourceUsage },
      });
      event({ kind: "capture", reason, phase, filename });
      process.stderr.write(`[worker-shutdown] ${reason}; phase=${phase}; evidence=${path.join(directory, filename)}\n`);
      captureTree();
    } finally { observing = false; }
  });

  globalThis[key] = {
    workerPhase: safe((next) => {
      clearTimeout(timer);
      phase = next;
      event({ kind: "worker-phase", phase });
      timer = setTimeout(() => capture("slow-worker-cleanup"), captureAfterMs);
      timer.unref();
    }),
    workerEnd: safe((failed) => {
      clearTimeout(timer);
      if (failed) capture("worker-cleanup-failed");
      event({ kind: "worker-end", failed });
      hook.disable();
    }),
    launched: safe((child, close) => {
      // Keep pending launches plus twenty completed launches for context.
      const completed = [...processes.entries()].filter(([, value]) => value.details.cleanupComplete);
      for (const [old] of completed.slice(0, Math.max(0, completed.length - 20))) processes.delete(old);
      const details = { pid: child.pid, executable: path.basename(child.spawnfile), owner: testOwner(), launchStack: stack(), stage: "launched", exitObserved: false, closeObserved: false, cleanupComplete: false };
      processes.set(close, { child, details });
      event({ kind: "launch", ...details });
      child.once("exit", safe((code, signal) => {
        details.exitObserved = true;
        event({ kind: "process-exit", pid: child.pid, code, signal });
      }));
      child.once("close", safe(() => {
        details.closeObserved = true;
        event({ kind: "process-close", pid: child.pid });
      }));
      return { stage: safe((next) => {
        details.stage = next;
        if (next === "cleaned") details.cleanupComplete = true;
        event({ kind: "process-stage", pid: child.pid, stage: next });
      }) };
    }),
  };
}
