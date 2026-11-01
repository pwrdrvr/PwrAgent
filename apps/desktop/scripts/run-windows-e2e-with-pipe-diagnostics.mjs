import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ancestry, bindPipeNames, exactLauncherPipes, HANDLE_INVENTORY_OPTIONS, packageManagerCommand, parseHandleOutput } from "./windows-pipe-observation.mjs";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const root = path.join(desktop, ".local", "windows-pipe-diagnostics", randomUUID());
const requests = path.join(root, "requests");
const evidence = path.join(root, "evidence");
const artifact = path.join(desktop, "test-results", "worker-shutdown", "native-controller");
const stopFile = path.join(root, "stop");
const executable = path.join(root, "windows-pipe-diagnostics.exe");
const handleExecutable = process.env.PWRAGENT_WINDOWS_HANDLE_EXE;
const rows = new Map();
const launches = new Map();
const processed = new Set();
const pending = new Set();
const scanners = new Set();
let watcher, requestWatcher, poll, liveArtifacts = false;
let nativeBytes = 0, omittedNativeRecords = 0, captures = 0, watcherAvailable = false;

// Raw tool output may contain unrelated file paths; persist only parsed pipe names.
const json = (data) => JSON.stringify(data, (key, value) => key === "toolText" ? undefined : value);
function write(filename, data) {
  try {
    mkdirSync(evidence, { recursive: true });
    writeFileSync(path.join(evidence, filename), json(data) + "\n");
    if (liveArtifacts) {
      mkdirSync(artifact, { recursive: true });
      writeFileSync(path.join(artifact, filename), json(data) + "\n");
    }
  } catch (error) { log("artifact-write-error", { filename, error: error.message }); }
}
function log(kind, data) {
  // Cancellation can skip artifact upload. Keep the trigger/result in the log.
  const line = json({ kind, ...data });
  console.error("[windows-pipe-evidence] " + (Buffer.byteLength(line) <= 8192
    ? line : json({ kind, evidenceOmittedFromLog: true, launchId: data.launchId })));
}
function nativeRecord(record) {
  if (record.kind === "start") rows.set(record.pid + ":" + record.created, record);
  if (record.kind === "gone") {
    const row = rows.get(record.pid + ":" + record.created);
    if (row) Object.assign(row, { goneAt: record.at, nativeExit: record.nativeExit, exitQueryError: record.error });
  }
  const line = json(record) + "\n";
  if (nativeBytes + Buffer.byteLength(line) > 8 * 1024 * 1024) { omittedNativeRecords++; return; }
  nativeBytes += Buffer.byteLength(line);
  appendFileSync(path.join(evidence, "native-processes.jsonl"), line);
  if (liveArtifacts) appendFileSync(path.join(artifact, "native-processes.jsonl"), line);
}
let activeQueries = 0;
const queryWaiters = [];
let stoppingQueries = false;
async function run(file, args, timeout = 3000, urgent = false) {
  const requested = Date.now();
  if (activeQueries < 2) activeQueries++;
  else await new Promise((resolve) => urgent ? queryWaiters.unshift(resolve) : queryWaiters.push(resolve));
  try {
    if (stoppingQueries) return { error: { message: "Controller finishing; query omitted." }, requested, started: Date.now(), ended: Date.now() };
    return await new Promise((resolve) => {
      const started = Date.now();
      const child = execFile(file, args, { timeout, maxBuffer: 512 * 1024, windowsHide: true }, (error, stdout, stderr) => {
        scanners.delete(child);
        let value;
        try { value = JSON.parse(stdout.trim()); } catch { /* An absent native result is explicit below. */ }
        const isHandle = file === handleExecutable;
        const failure = error && { message: isHandle ? "Handle query execution failed." : error.message,
          code: error.code, signal: error.signal, killed: error.killed };
        const stderrBytes = Buffer.byteLength(stderr);
        const parsed = isHandle ? parseHandleOutput(stdout, args.includes("-p") ? Number(args[args.indexOf("-p") + 1]) : undefined,
          { error: failure, stderrBytes }) : undefined;
        resolve({ value: isHandle ? undefined : value, toolText: isHandle ? stdout : undefined, error: failure,
          inventoryStatus: parsed?.status, recognizedHandleCount: parsed?.recognizedHandleCount, unrecognizedLineCount: parsed?.unrecognizedLineCount,
          compilerOutput: file.toLowerCase().endsWith("csc.exe") ? stdout.slice(0, 2048) : undefined,
          stderr: isHandle ? undefined : stderr.slice(0, 1024), stderrBytes, requested, started, ended: Date.now(), stdoutBytes: Buffer.byteLength(stdout) });
      });
      scanners.add(child);
    });
  } finally {
    const next = queryWaiters.shift();
    if (next) next();
    else activeQueries--;
  }
}

async function namedInventory(pid, deadline = Date.now() + 5000) {
  const query = (file, args, cap) => Date.now() >= deadline
    ? Promise.resolve({ error: { message: "Capture window elapsed; query omitted." } })
    : run(file, args, Math.min(cap, Math.max(1, deadline - Date.now())), true);
  const before = await query(executable, ["identity", String(pid)], 2000);
  const tool = await query(handleExecutable, [...HANDLE_INVENTORY_OPTIONS, "-p", String(pid)], Math.max(1, deadline - Date.now()));
  const after = await query(executable, ["identity", String(pid)], 2000);
  const queries = { before, tool, after };
  if (before.error || after.error) return { error: "Identity query failed.", queries };
  const source = bindPipeNames(before.value?.process, after.value?.process, tool.toolText ?? "", tool);
  return { source, error: source.error, queries };
}
async function inventory(event) {
  const result = await namedInventory(event.pid);
  const source = result.source;
  const sourceRow = source && rows.get(source.pid + ":" + source.created);
  const correctParent = sourceRow?.ppid === event.workerPid && sourceRow.name.toLowerCase() === "electron.exe"
    && BigInt(source.created) <= (BigInt(event.at) + 1n) * 10000n + 116444736000000000n;
  const endpoints = !result.error && correctParent && !event.omittedCandidates
    ? exactLauncherPipes(event.candidates, source)
    : { error: "Main query failed, ancestry was not observed, or candidate pool was incomplete." };
  write("launch-" + event.launchId + ".json", { event, result, endpoints, watcherAvailable,
    ancestry: source?.created && ancestry(rows, source.pid, source.created) });
  return { event, result, endpoints, source };
}
async function capture(event) {
  write("trigger-" + event.launchId + ".json", { event, observedAt: Date.now(), watcherAvailable });
  log("natural-exit-open-pipes", { ...event, observedAt: Date.now() });
  if (++captures > 4) {
    write("match-" + event.launchId + ".json", { event, error: "Per-run scan limit reached.", omittedScan: true });
    return;
  }
  const launch = await launches.get(event.launchId);
  if (!launch?.endpoints.names) {
    const failure = { launchId: event.launchId, error: "Four exact native main endpoints unavailable.", launchError: launch?.endpoints.error };
    write("match-" + event.launchId + ".json", failure);
    log("match-unavailable", failure);
    return;
  }
  const launchQueryOverlappedExit = launch.result.queries.tool.ended >= event.at;
  const deadline = Date.now() + 5000;
  const matches = [];
  const survivors = [...rows.values()].filter((row) => !row.goneAt && row.pid !== event.pid
    && ancestry(rows, row.pid, row.created).chain.some((parent) => parent.pid === event.pid && parent.created === launch.source.created));
  let omittedProcesses = Math.max(0, survivors.length - 16);
  const inspect = async (pid, expectedCreated, reason) => {
    const result = await namedInventory(pid, deadline);
    const source = result.source;
    const names = new Set(source?.pipes?.map((pipe) => pipe.name));
    const row = source?.created && rows.get(pid + ":" + source.created);
    const diagnosticProcess = pid === process.pid || pid === watcher?.pid
      || (row?.executable?.toLowerCase() === handleExecutable.toLowerCase() && row.ppid === process.pid);
    matches.push({ pid, created: source?.created, expectedCreated, reason, result, diagnosticProcess,
      allFourExactNames: launch.endpoints.names.every((name) => names.has(name)),
      sourceVerifiedAndLive: source?.verified === true && source?.liveAfter === true
        && (!expectedCreated || expectedCreated === source.created),
      ancestry: source?.created && ancestry(rows, pid, source.created) });
  };
  for (const row of survivors.slice(0, 16)) {
    if (Date.now() >= deadline) { omittedProcesses += Math.min(16, survivors.length) - matches.length; break; }
    await inspect(row.pid, row.created, "preserved-descendant");
  }
  let global;
  let parsed;
  let globalSearchStatus = "not-needed";
  if (!matches.some((match) => match.allFourExactNames && match.sourceVerifiedAndLive)) {
    globalSearchStatus = "capture-window-expired";
    if (Date.now() < deadline) {
      // The fragment narrows enumeration only. Complete equality is required.
      global = await run(handleExecutable, [...HANDLE_INVENTORY_OPTIONS, "\\Device\\NamedPipe\\uv\\"],
        Math.min(1500, Math.max(1, deadline - Date.now())), true);
      parsed = parseHandleOutput(global.toolText ?? "", undefined, global);
      globalSearchStatus = parsed.status;
      const candidates = (parsed.status === "inventory" ? parsed.processes : []).filter((source) => {
        const found = new Set(source.pipes.map((pipe) => pipe.name));
        return launch.endpoints.names.every((name) => found.has(name));
      });
      omittedProcesses += Math.max(0, candidates.length - 8);
      for (const [index, candidate] of candidates.slice(0, 8).entries()) {
        if (Date.now() >= deadline) { omittedProcesses += Math.min(8, candidates.length) - index; break; }
        await inspect(candidate.pid, undefined, "global-exact-name-candidate");
      }
    }
  }
  const report = { launchId: event.launchId, trigger: event, launchQueryOverlappedExit, global, globalSearchStatus,
    globalErrors: parsed?.errors, omittedGlobalErrors: parsed?.omittedErrors, matches, omittedProcesses,
    expectedNames: launch.endpoints.names, attribution: "An exact verified holder is an observation; its launch cause is not inferred." };
  write("match-" + event.launchId + ".json", report);
  log("match-result", { launchId: event.launchId, ended: Date.now(), launchQueryOverlappedExit,
    expectedNames: launch.endpoints.names, globalSearchStatus, globalError: global?.error,
    omittedProcesses, matches: matches.map(({ pid, created, allFourExactNames, sourceVerifiedAndLive, diagnosticProcess, ancestry: chain, result }) => ({
      pid, created, allFourExactNames, sourceVerifiedAndLive, diagnosticProcess, ancestryStatus: chain?.status,
      matchedNames: result.source?.pipes?.filter(({ name }) => launch.endpoints.names.includes(name)),
      before: result.queries.before.value?.process, after: result.queries.after.value?.process,
      queryStarted: result.queries.tool.started, queryEnded: result.queries.tool.ended,
      error: result.error ?? result.source?.error,
      inventoryStatus: result.queries.tool.inventoryStatus,
    })) });
}

function enqueue(task) {
  const operation = task.catch((error) => log("capture-error", { error: error.message }));
  pending.add(operation);
  void operation.finally(() => pending.delete(operation));
}
function scanRequests() {
  for (const filename of readdirSync(requests).sort()) {
    if (!filename.endsWith(".json") || processed.has(filename)) continue;
    processed.add(filename);
    if (processed.size > 2048) { log("request-limit", { omitted: processed.size - 2048 }); continue; }
    const event = JSON.parse(readFileSync(path.join(requests, filename), "utf8"));
    if (!/^[a-f0-9-]{36}$/.test(event.launchId)) continue;
    if (!liveArtifacts) { cpSync(evidence, artifact, { recursive: true }); liveArtifacts = true; }
    if (event.kind === "launch") {
      const operation = inventory(event);
      launches.set(event.launchId, operation);
      enqueue(operation);
    }
    if (event.kind === "trigger") enqueue(capture(event));
  }
}
async function startObserver() {
  mkdirSync(requests, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  if (!handleExecutable || !path.isAbsolute(handleExecutable) || !existsSync(handleExecutable)) throw new Error("Official Handle utility is unavailable.");
  write("tools.json", { handleSha256: createHash("sha256").update(readFileSync(handleExecutable)).digest("hex"),
    nativeSourceSha256: createHash("sha256").update(readFileSync(path.join(desktop, "scripts", "windows-pipe-diagnostics.cs"))).digest("hex") });
  const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const compiled = await run(compiler, ["/nologo", "/platform:x64", "/r:System.Web.Extensions.dll", "/out:" + executable,
    path.join(desktop, "scripts", "windows-pipe-diagnostics.cs")], 10000);
  if (compiled.error) throw new Error("Native diagnostic compilation failed: " + json(compiled));
  watcher = spawn(executable, ["watch", stopFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Native ancestry observer did not become ready.")), 10000);
    watcher.once("error", reject);
    watcher.once("exit", (code) => {
      watcherAvailable = false;
      clearTimeout(timer);
      log("watcher-exit", { code });
      reject(new Error("Native ancestry observer exited before readiness."));
    });
    watcher.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const record = JSON.parse(line);
          nativeRecord(record);
          if (record.kind === "ready") { watcherAvailable = true; clearTimeout(timer); resolve(); }
        } catch (error) { log("watcher-record-error", { error: error.message }); }
      }
    });
    watcher.stderr.on("data", (chunk) => log("watcher-stderr", { text: chunk.toString().slice(0, 1024) }));
  });
  requestWatcher = watch(requests, () => {
    try { scanRequests(); } catch (error) { log("request-error", { error: error.message }); }
  });
  poll = setInterval(() => {
    try { scanRequests(); } catch (error) { log("request-error", { error: error.message }); }
  }, 25);
}
async function closeObserver() {
  try {
    clearInterval(poll);
    requestWatcher?.close();
    try { if (existsSync(requests)) scanRequests(); } catch (error) { log("request-error", { error: error.message }); }
    let timer;
    await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => { timer = setTimeout(resolve, 8000); })]);
    clearTimeout(timer);
    stoppingQueries = true;
    for (const child of scanners) child.kill();
    await Promise.allSettled([...pending]);
    writeFileSync(stopFile, "stop");
    if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
      await Promise.race([new Promise((resolve) => watcher.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 1000))]);
      if (watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
    }
    write("summary.json", { captures, omittedNativeRecords, watcherAvailable, processIdentities: rows.size,
      requestCount: processed.size, limitation: "50ms polling can miss short processes. Query/report work affects scheduling; timing alone is not attribution." });
    cpSync(evidence, artifact, { recursive: true });
  } finally {
    stoppingQueries = true;
    clearInterval(poll);
    requestWatcher?.close();
    for (const child of scanners) child.kill();
    if (watcher && watcher.exitCode === null && watcher.signalCode === null) watcher.kill();
  }
}
async function main() {
  const command = packageManagerCommand(process.env.npm_execpath,
    ["--filter", "@pwragent/desktop", "test:e2e", ...process.argv.slice(2)]);
  let enabled = false;
  try {
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Native diagnostics require Windows x64.");
    await startObserver();
    enabled = true;
  } catch (error) {
    watcher?.kill();
    write("setup-error.json", { error: error.message });
    log("setup-error", { error: error.message });
  }
  // Same build/test command, shards, worker count, retries and deadlines as CI.
  // All diagnostic children belong to this controller, before launcher pipes exist.
  const child = spawn(command.file, command.args, {
    stdio: "inherit", env: { ...process.env, ...(enabled ? { PWRAGENT_WINDOWS_PIPE_REQUESTS: requests } : {}) },
  });
  let code;
  try {
    code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  } finally {
    try { await closeObserver(); } catch (error) { log("controller-cleanup-error", { error: error.message }); }
  }
  process.exitCode = code ?? 1;
}
process.once("exit", () => { watcher?.kill(); for (const child of scanners) child.kill(); });
await main();
