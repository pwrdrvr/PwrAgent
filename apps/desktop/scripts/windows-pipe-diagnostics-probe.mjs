// Controlled validation for the read-only native helper. No Electron or product state.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bindPipeNames, exactLauncherPipes, HANDLE_INVENTORY_OPTIONS } from "./windows-pipe-observation.mjs";
import { nativeDebuggerStatus, nativeStackArguments, parseNativeStacks } from "./windows-native-stack.mjs";

const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-native-pipe-proof-"));
const executable = path.join(directory, "native.exe");
const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const stop = path.join(directory, "watch.stop");
const stopSource = path.join(directory, "source.stop");
const readySource = path.join(directory, "source.ready");
const heartbeat = path.join(directory, "source.heartbeat");
const records = [];
const execute = promisify(execFile);
async function exec(...args) {
  try { return await execute(...args); }
  catch (error) {
    // execFile errors embed raw stdout/stderr. Even a failed controlled probe
    // must not dump unrelated object names into test or CI logs.
    throw new Error("Controlled diagnostic command failed: " + JSON.stringify({
      code: error.code, signal: error.signal, killed: error.killed,
    }));
  }
}
let watcher, child, lines, sourceClosed, watcherClosed, debuggerProcess, debuggerClosed;
export let probeResult;
// When imported by the controller, these are its directly owned leaf children.
// Never put a kill deadline around an intermediate probe process.
const stopOnExit = () => {
  for (const owned of [debuggerProcess, child, watcher]) {
    if (owned && owned.exitCode === null && owned.signalCode === null) owned.kill();
  }
};
process.once("exit", stopOnExit);
async function bounded(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
}
async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { assert(Date.now() < deadline, message); await delay(20); }
}
async function stopOwned(process, closing, marker) {
  writeFileSync(marker, "stop");
  if (!process) return;
  try { await bounded(closing, 2000, "Controlled child did not close"); }
  catch {
    process.kill();
    await bounded(closing, 2000, "Controlled child did not close after kill");
    throw new Error("Controlled child required forced cleanup");
  }
}
try {
  await exec(compiler, ["/nologo", "/platform:x64", "/r:System.Web.Extensions.dll", "/out:" + executable,
    path.join(import.meta.dirname, "windows-pipe-diagnostics.cs")], { windowsHide: true, timeout: 20000 });
  const ready = Promise.withResolvers();
  watcher = spawn(executable, ["watch", stop], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  watcherClosed = once(watcher, "close");
  void watcherClosed.catch(() => {});
  lines = createInterface({ input: watcher.stdout });
  lines.on("line", (line) => {
    try { const row = JSON.parse(line); records.push(row); if (row.kind === "ready") ready.resolve(); }
    catch (error) { ready.reject(error); }
  });
  watcher.once("error", ready.reject);
  watcher.once("exit", () => ready.reject(new Error("Native watcher exited before ready")));
  await bounded(ready.promise, 5000, "Native watcher readiness was not observed");
  const oldNames = new Set(process.report.getReport().libuv.flatMap((handle) => [handle.localEndpoint, handle.remoteEndpoint]));
  const source = "const fs=require('node:fs');let beat=0;fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{fs.writeFileSync(process.argv[3],String(++beat));if(fs.existsSync(process.argv[2]))process.exit(0)},20)";
  child = spawn(process.execPath, ["-e", source, readySource, stopSource, heartbeat], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
  });
  sourceClosed = once(child, "close");
  void sourceClosed.catch(() => {});
  for (const stream of child.stdio.filter(Boolean)) stream.resume();
  await waitFor(() => existsSync(readySource), "Controlled source did not become ready");
  const inventoryDeadline = Date.now() + 5000;
  const result = JSON.parse((await exec(executable, ["identity", String(child.pid)], { timeout: 3000, windowsHide: true })).stdout);
  assert.equal(result.process.verified, true);
  assert.equal(result.process.liveAfter, true);
  let exactPipes;
  const handle = process.env.PWRAGENT_WINDOWS_HANDLE_EXE;
  if (handle) {
    const tool = await exec(handle, [...HANDLE_INVENTORY_OPTIONS, "-p", String(child.pid)], { timeout: Math.max(1, inventoryDeadline - Date.now()), windowsHide: true });
    const after = JSON.parse((await exec(executable, ["identity", String(child.pid)], { timeout: 3000, windowsHide: true })).stdout);
    const named = bindPipeNames(result.process, after.process, tool.stdout);
    assert.equal(named.nameQueryStatus, "inventory");
    const candidates = process.report.getReport().libuv.flatMap((entry) => [entry.localEndpoint, entry.remoteEndpoint])
      .filter((name) => typeof name === "string" && !oldNames.has(name) && name.endsWith("-" + process.pid));
    const endpoints = exactLauncherPipes(candidates, named);
    assert.equal(endpoints.error, undefined);
    assert.equal(endpoints.names.length, 4);
    const identity = JSON.parse((await exec(executable, ["identity", String(child.pid)], { timeout: 3000, windowsHide: true })).stdout);
    assert.equal(identity.process.created, result.process.created);
    assert.equal(identity.process.liveAfter, true);
    exactPipes = 4;
  }

  let noninvasiveDebuggerVerified;
  let debuggerQuitVerified;
  if (process.env.PWRAGENT_WINDOWS_CDB_EXE) {
    let lastBeat = 0;
    const readBeat = () => {
      if (existsSync(heartbeat)) lastBeat = Math.max(lastBeat, Number(readFileSync(heartbeat, "utf8")) || 0);
      return lastBeat;
    };
    await waitFor(() => readBeat() > 0, "Controlled source heartbeat did not start");
    let output = "", errorOutput = "";
    const startDebugger = (command) => {
      output = ""; errorOutput = "";
      debuggerProcess = spawn(process.env.PWRAGENT_WINDOWS_CDB_EXE,
        nativeStackArguments(child.pid, directory, command),
        { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      debuggerClosed = once(debuggerProcess, "close");
      void debuggerClosed.catch(() => {});
      debuggerProcess.stdout.on("data", (chunk) => { output = (output + chunk).slice(-512 * 1024); });
      debuggerProcess.stderr.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-64 * 1024); });
    };
    try {
      const readyDebugger = Promise.withResolvers();
      startDebugger(".echo pwragent-noninvasive-ready;~* kn 40");
      debuggerProcess.stdout.on("data", () => {
        if (output.includes("pwragent-noninvasive-ready")) readyDebugger.resolve();
      });
      debuggerProcess.once("error", readyDebugger.reject);
      debuggerProcess.once("exit", () => readyDebugger.reject(new Error("Noninvasive debugger exited before readiness")));
      await bounded(readyDebugger.promise, 5000, "Noninvasive debugger readiness was not observed");
      await waitFor(() => parseNativeStacks(output).frameCount > 0, "Noninvasive debugger did not produce native frames");
      const attachedBeat = readBeat();
      await waitFor(() => readBeat() > attachedBeat + 2, "Debugger suspended the controlled source");
      assert.equal(debuggerProcess.exitCode, null);
      debuggerProcess.kill();
      await bounded(debuggerClosed, 2000, "Cancelled noninvasive debugger did not close");
      const cancelledBeat = readBeat();
      await waitFor(() => readBeat() > cancelledBeat + 2, "Debugger cancellation suspended the controlled source");

      // Exercise the ordinary capture command too: q must leave the same
      // controlled source alive, just as cancellation does.
      startDebugger();
      await bounded(debuggerClosed, 5000, "Noninvasive debugger quit did not close");
      assert.equal(debuggerProcess.exitCode, 0, "Noninvasive debugger quit failed");
      assert(parseNativeStacks(output).frameCount > 0, "Noninvasive debugger did not produce native frames");
      const quitBeat = readBeat();
      await waitFor(() => readBeat() > quitBeat + 2, "Debugger quit stopped the controlled source");
      noninvasiveDebuggerVerified = true;
      debuggerQuitVerified = true;
    } catch (error) {
      error.nativeDebugger = { ...nativeDebuggerStatus(output + "\n" + errorOutput), exitCode: debuggerProcess?.exitCode };
      throw error;
    }
  }

  writeFileSync(stopSource, "stop");
  await bounded(sourceClosed, 3000, "Controlled source did not finish");
  await waitFor(() => records.some((row) => row.kind === "gone" && row.pid === child.pid
    && row.created === result.process.created && BigInt(row.nativeExit) > 0n), "Native source exit FILETIME was not retained");
  probeResult = { creationIdentityVerified: true, nativeExitTimeVerified: true, noninvasiveDebuggerVerified, debuggerQuitVerified, exactPipes };
} finally {
  try {
    if (debuggerProcess && debuggerProcess.exitCode === null && debuggerProcess.signalCode === null) {
      debuggerProcess.kill();
      await bounded(debuggerClosed, 2000, "Noninvasive debugger cleanup did not finish");
    }
  } finally {
    try { await stopOwned(child, sourceClosed, stopSource); }
    finally {
      try { await stopOwned(watcher, watcherClosed, stop); }
      finally {
        lines?.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert(path.basename(directory).startsWith("pwragent-native-pipe-proof-"));
        rmSync(directory, { recursive: true, force: true });
        if ([debuggerProcess, child, watcher].every((owned) => !owned || owned.exitCode !== null || owned.signalCode !== null)) {
          process.removeListener("exit", stopOnExit);
        }
      }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(probeResult));

