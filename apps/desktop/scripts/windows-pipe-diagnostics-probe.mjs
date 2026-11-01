// Controlled validation for the read-only native helper. No Electron or product state.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { bindPipeNames, exactLauncherPipes, HANDLE_INVENTORY_OPTIONS } from "./windows-pipe-observation.mjs";

const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-native-pipe-proof-"));
const executable = path.join(directory, "native.exe");
const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const stop = path.join(directory, "watch.stop");
const stopSource = path.join(directory, "source.stop");
const readySource = path.join(directory, "source.ready");
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
let watcher, child, lines, sourceClosed, watcherClosed;
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
  const source = "const fs=require('node:fs');fs.writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},20)";
  child = spawn(process.execPath, ["-e", source, readySource, stopSource], {
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

  writeFileSync(stopSource, "stop");
  await bounded(sourceClosed, 3000, "Controlled source did not finish");
  await waitFor(() => records.some((row) => row.kind === "gone" && row.pid === child.pid
    && row.created === result.process.created && BigInt(row.nativeExit) > 0n), "Native source exit FILETIME was not retained");
  console.log(JSON.stringify({ creationIdentityVerified: true, nativeExitTimeVerified: true, exactPipes }));
} finally {
  try { await stopOwned(child, sourceClosed, stopSource); }
  finally {
    try { await stopOwned(watcher, watcherClosed, stop); }
    finally {
      lines?.close();
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert(path.basename(directory).startsWith("pwragent-native-pipe-proof-"));
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

