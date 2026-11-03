import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { observeWindowsLauncher } from "./windows-pipe-observation.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const CLOSE_MS = 6_000;
const READY_MS = 30_000;

export function probeOptions(args) {
  const { values } = parseArgs({ args, options: {
    samples: { type: "string", default: "3" },
    "output-dir": { type: "string" },
  } });
  const samples = Number(values.samples);
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error("samples must be between 1 and 100");
  return { samples, output: path.resolve(values["output-dir"]
    ?? path.join(directory, "../.local/native-quit-probe", randomUUID())) };
}

async function bounded(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

function writeRequest(requests, event) {
  if (!requests) return;
  const filename = path.join(requests, randomUUID());
  writeFileSync(filename + ".tmp", JSON.stringify(event));
  renameSync(filename + ".tmp", filename + ".json");
}

export function parseProbeRecord(line) {
  if (!line.startsWith("ELECTRON_NATIVE_QUIT ")) return undefined;
  const event = JSON.parse(line.slice("ELECTRON_NATIVE_QUIT ".length));
  if (typeof event.stage !== "string" || !Number.isFinite(event.at) || !Number.isInteger(event.pid)) {
    throw new Error("Invalid Electron probe event");
  }
  return event;
}

async function runCase({ output, index, mode, electron }) {
  const root = path.join(output, `${index}-${mode}`);
  mkdirSync(root);
  for (const name of ["user-data", "session-data"]) mkdirSync(path.join(root, name));
  const events = [];
  const record = (kind, data = {}) => {
    const event = { at: Date.now(), kind, ...data };
    events.push(event);
    appendFileSync(path.join(root, "events.jsonl"), JSON.stringify(event) + "\n");
  };
  const childEnv = { ...process.env };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [
    "--remote-debugging-pipe", path.join(directory, "fixtures/electron-native-quit.cjs"),
    "--probe-root=" + root, ...(mode === "session-drain" ? ["--session-drain"] : []),
  ], { env: childEnv, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => { record("process-close", { code, signal }); resolve({ code, signal }); });
  });
  closed.catch(() => undefined);
  child.once("exit", (code, signal) => record("process-exit", { code, signal }));
  // Retain only byte counts from arbitrary Chromium stderr and DevTools output.
  let stderrBytes = 0;
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    stderrTail = (stderrTail + chunk.toString()).slice(-32_768);
  });
  child.stdio[3].resume();
  child.stdio[4].resume();
  const requests = process.env.PWRAGENT_WINDOWS_PIPE_REQUESTS;
  const launchId = process.platform === "win32"
    ? observeWindowsLauncher(child, { directory: requests, logEvidence: record }) : undefined;
  record("launch", { pid: child.pid, launchId, mode });
  let buffer = "";
  let ready, failed, storageDirectory, protocolError;
  const readiness = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
  readiness.catch(() => undefined);
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const event = parseProbeRecord(line);
        if (!event) continue;
        if (event.pid !== child.pid) throw new Error("Probe PID did not match the native launcher");
        record("app-stage", event);
        if (event.stage === "ready") { storageDirectory = event.storageDirectory; ready(); }
        if (event.stage === "app-error") failed(new Error(event.message));
      } catch (error) { protocolError = error; failed(error); }
    }
    if (buffer.length > 16_384) {
      protocolError = new Error("Probe stdout exceeded the record bound");
      failed(protocolError);
    }
  });
  let timer;
  try {
    await bounded(Promise.race([readiness, closed.then(() => { throw new Error("Electron closed before readiness"); })]), READY_MS, "Electron readiness timed out");
    // Let the existing native controller bind all four exact pipe names before
    // beginning a measured quit. No debugger or symbol work is added here.
    if (requests) {
      const evidence = process.env.PWRAGENT_WINDOWS_PIPE_EVIDENCE;
      if (!evidence || !launchId) throw new Error("Native launch evidence is unavailable");
      const filename = path.join(evidence, "launch-" + launchId + ".json");
      await bounded((async () => {
        for (;;) {
          let launch;
          try { launch = JSON.parse(readFileSync(filename, "utf8")); } catch { /* Controller is still writing. */ }
          if (launch) {
            if (launch.endpoints?.names?.length !== 4) throw new Error("Four exact launcher pipes were not verified");
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      })(), READY_MS, "Native launch inventory timed out");
    }
    const closeStartedAt = Date.now();
    const closeStarted = performance.now();
    record("quit-requested", { closeStartedAt });
    timer = setTimeout(() => writeRequest(requests, {
      kind: "stalled", workerPid: process.pid, pid: child.pid, at: Date.now(), closeStartedAt,
    }), 3_000);
    writeFileSync(path.join(root, "quit"), "quit\n");
    const exit = await bounded(closed, CLOSE_MS, "Electron did not close within 6000ms");
    const elapsedMs = Math.round(performance.now() - closeStarted);
    if (protocolError) throw protocolError;
    const stages = new Set(events.filter((event) => event.kind === "app-stage").map((event) => event.stage));
    if (!["ready", "app-quit-requested", "before-quit", "will-quit", "quit", "node-exit"].every((stage) => stages.has(stage))) {
      throw new Error("Electron closed without the complete ordinary quit lifecycle");
    }
    const files = readdirSync(path.join(root, storageDirectory))
      .filter((name) => /^DIPS(?:-|$)/.test(name))
      .map((name) => ({ name, bytes: statSync(path.join(root, storageDirectory, name)).size }));
    const result = { index, mode, pid: child.pid, launchId, elapsedMs, ...exit, stderrBytes, btmFiles: files,
      classification: elapsedMs >= CLOSE_MS ? "deadline-exceeded" : elapsedMs >= 4_000 ? "slow" : "healthy" };
    writeFileSync(path.join(root, "result.json"), JSON.stringify(result, null, 2) + "\n");
    if (exit.code !== 0 || result.classification === "deadline-exceeded") throw new Error("Abnormal native Electron close");
    return result;
  } catch (error) {
    record("case-error", { message: error.message, stderrBytes });
    writeFileSync(path.join(root, "result.json"), JSON.stringify({
      index, mode, pid: child.pid, launchId, outcome: "failed", error: error.message, stderrBytes,
    }, null, 2) + "\n");
    writeFileSync(path.join(root, "stderr-tail.txt"), stderrTail);
    // Windows failures leave this worker immediately; its enclosing atomic Job
    // then closes, killing only this probe's descendants. Preserve every file.
    if (process.platform !== "win32" && child.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* Group already exited. */ }
      await bounded(closed, 1_000, "Probe process group did not close after cleanup");
    }
    throw error;
  } finally { clearTimeout(timer); }
}

async function matrix(options) {
  mkdirSync(path.dirname(options.output), { recursive: true });
  mkdirSync(options.output);
  console.log(JSON.stringify({ kind: "probe-output", directory: options.output }));
  const electron = require("electron");
  const metadata = { platform: process.platform, arch: process.arch, node: process.version,
    electronSha256: createHash("sha256").update(readFileSync(electron)).digest("hex"), closeDeadlineMs: CLOSE_MS,
    samplesPerMode: options.samples, observationOnly: true };
  writeFileSync(path.join(options.output, "setup.json"), JSON.stringify(metadata, null, 2) + "\n");
  const results = [];
  for (let index = 1; index <= options.samples; index++) {
    for (const mode of index % 2 ? ["plain", "session-drain"] : ["session-drain", "plain"]) {
      const result = await runCase({ ...options, index, mode, electron });
      results.push(result);
      writeFileSync(path.join(options.output, "summary.json"), JSON.stringify({ ...metadata, results }, null, 2) + "\n");
      console.log(JSON.stringify(result));
    }
  }
}

async function main() {
  const options = probeOptions(process.argv.slice(2));
  if (process.platform !== "win32" || process.env.PWRAGENT_NATIVE_QUIT_PROBE_JOB === "1") {
    await matrix(options);
    return;
  }
  // Only the experiment worker is inside this Job. Native observers remain
  // outside it, so they can retain root exit FILETIMEs after a failed case.
  const { wrapCommandInWindowsJob, startWindowsJobReadyPoll, formatWindowsJobStartupTimeout } =
    await import("../src/main/windows-job-wrapper.ts");
  const launch = wrapCommandInWindowsJob({ command: process.execPath,
    args: [fileURLToPath(import.meta.url), "--samples", String(options.samples), "--output-dir", options.output],
    env: { ...process.env, PWRAGENT_NATIVE_QUIT_PROBE_JOB: "1" } });
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: "inherit", windowsHide: true });
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  process.once("exit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let poll;
  try {
    child.once("spawn", () => {
      poll = startWindowsJobReadyPoll({ launch, onReady: () => {}, onTimeout: (failure) => {
        console.error(formatWindowsJobStartupTimeout(failure));
        child.kill("SIGKILL");
      } });
    });
    const code = await new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
    process.exitCode = code ?? 1;
  } finally {
    poll?.cancel();
    process.removeListener("exit", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    launch.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    // The Windows worker's enclosing Job guarantees cleanup even if Electron
    // is still in native teardown. An exit code alone never counts as a pass.
    process.exit(1);
  });
}
