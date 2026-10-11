#!/usr/bin/env node
// The same real Electron/preload IPC path as lib/live-app.ts, without UI input.
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { EXIT, assertReady, atomicJson, captureLaunchRejections, claimRun, cleanEnvironment, configToml, dispatchTurn, errorStatus, launchHeadlessElectron, observeFamilyBudget, sanitizer, budgetStop, waitForOutcome, probeInterrupt, sanitizedProtocolRecord, validateInput } from "./lib/headless-contract.mjs";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--output") {
  console.error("Usage: node apps/desktop/eval/run-headless.mjs --input /eval/input.json --output /eval/output");
  process.exit(2);
}
const output = path.resolve(args[3]);
let result = { schemaVersion: 1, status: "preflight_failed", exitCode: 2 };
let app;
let call;
let claim;
let input;
let redact = sanitizer();
let stopReason;
let watchdog;
let logFd;
const logSubscriptions = [];
const deadlineCall = (promise, ms = 30_000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("IPC deadline exceeded")), ms); })]).finally(() => clearTimeout(timer));
};
const persist = () => atomicJson(claim.file, redact({ ...result, inputHash: claim.hash }));
const requestStop = (reason) => { stopReason ??= reason; };
process.on("SIGINT", () => requestStop("cancelled"));
process.on("SIGTERM", () => requestStop("cancelled"));
function git(args, options = {}) { return execFileSync("git", ["-C", input.cwd, ...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options }); }
function strings(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
async function exportProtocol(root) {
  const destination = path.join(output, "protocol.jsonl");
  writeFileSync(destination, "", { mode: 0o600 });
  async function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.name.endsWith(".jsonl")) {
        const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        for await (const line of lines) {
          if (!line.trim()) continue;
          // CaptureStore keeps the wire payload only in raw. Parse it before
          // redacting so usage/capability evidence survives without an unsafe
          // second copy of serialized credential fields.
          appendFileSync(destination, JSON.stringify(sanitizedProtocolRecord(JSON.parse(line), redact)) + "\n");
        }
      }
    }
  }
  if (existsSync(root)) await walk(root);
}
try {
  input = validateInput(JSON.parse(readFileSync(args[1], "utf8")));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  claim = claimRun(output, input);
  if (claim.prior) {
    // Deliberately never resume/redispatch an uncertain attempt. The spend
    // owner must reconcile it and choose a NEW runId + output directory.
    console.log(JSON.stringify({ runId: input.runId, status: claim.prior.status, repeated: true }));
    process.exit(EXIT[claim.prior.status] ?? EXIT.incomplete);
  }
  result = { ...result, runId: input.runId, model: input.model, reasoningEffort: input.reasoningEffort, serviceTier: input.serviceTier, tokenMiser: input.tokenMiser, startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch };
  persist();
  if (process.platform !== "linux" || process.getuid?.() === 0) throw new Error("Run in Linux as a non-root user with Electron sandbox enabled");
  if (!process.env.DISPLAY) throw new Error("DISPLAY required; use xvfb-run -a");
  for (const dir of [input.cwd, input.codexHome]) if (!statSync(dir).isDirectory()) throw new Error(`Missing directory: ${dir}`);
  const paths = [input.cwd, input.profileDir, input.codexHome, output].map((p) => path.resolve(p));
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (paths[i] === paths[j] || paths[i].startsWith(paths[j] + "/") || paths[j].startsWith(paths[i] + "/")) throw new Error("Task, profile, Codex home and output must be separate directories");
  if (existsSync(input.profileDir) && readdirSync(input.profileDir).length) throw new Error("Profile must be fresh/empty for each run");
  if (readdirSync(input.codexHome).some((name) => name !== "auth.json")) throw new Error("Fresh CODEX_HOME must contain only the mounted auth.json");
  const authPath = path.join(input.codexHome, "auth.json");
  const mounts = readFileSync("/proc/self/mountinfo", "utf8").split("\n");
  if (!mounts.some((line) => { const f = line.split(" "); return f[4] === authPath && f[5]?.split(",").includes("ro"); })) throw new Error("auth.json must be an individual read-only bind mount");
  redact = sanitizer(strings(JSON.parse(readFileSync(authPath, "utf8"))));
  const runtime = JSON.parse(readFileSync(input.runtimeManifest, "utf8"));
  result.runtime = runtime;
  const baseCommit = git(["rev-parse", "HEAD"]).trim();
  result.baseCommit = baseCommit;
  const profile = path.join(input.profileDir, "profiles/default");
  const home = path.join(input.profileDir, "home");
  mkdirSync(profile, { recursive: true, mode: 0o700 });
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(profile, "config.toml"), configToml(input, path.join(runtime.directory, "codex")), { mode: 0o600 });
  const captureRoot = path.join(input.profileDir, "protocol");
  const env = cleanEnvironment(input, home, captureRoot);
  const { _electron: electron } = await import("@playwright/test");
  watchdog = setTimeout(() => requestStop("timeout"), input.timeoutMs);
  // A bounded overall watchdog also covers a hung launch/IPC/cleanup. Container
  // --init owns orphan reaping; app.close handles the normal child shutdown.
  watchdog.unref();
  await captureLaunchRejections(async () => {
    app = await launchHeadlessElectron(electron, desktopRoot, env);
  });
  logFd = openSync(path.join(output, "app.log"), "w", 0o600);
  for (const stream of [app.process().stdout, app.process().stderr]) {
    if (!stream) continue;
    let pending = "";
    const listener = (chunk) => {
      pending += chunk.toString();
      const end = pending.lastIndexOf("\n");
      if (end >= 0) { writeFileSync(logFd, redact(pending.slice(0, end + 1))); pending = pending.slice(end + 1); }
    };
    stream.on("data", listener);
    logSubscriptions.push(() => { stream.off("data", listener); if (pending) writeFileSync(logFd, redact(pending)); });
  }
  const page = await app.firstWindow({ timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.pwragent?.listBackends), undefined, { timeout: 60_000 });
  call = (method, arg) => deadlineCall(page.evaluate(({ method, arg }) => {
    if (typeof window.pwragent[method] !== "function") throw new Error(`Unsupported IPC: ${method}`);
    return window.pwragent[method](arg);
  }, { method, arg }));
  await page.evaluate(() => {
    window.__headlessEvents = [];
    window.pwragent.onAgentEvent((event) => window.__headlessEvents.push(event));
  });
  const drain = () => deadlineCall(page.evaluate(() => window.__headlessEvents.splice(0)));
  let backend;
  let settings;
  const readyDeadline = Date.now() + 60_000;
  do {
    const backends = await call("listBackends", { includeUnavailable: true, refreshModels: "codex", discoveryIntent: "settings-user-action" });
    backend = backends.backends.find((b) => b.kind === "codex");
    settings = (await call("readSettings")).snapshot;
    result.readiness = {
      backend: backend && { available: backend.available, discoveryPending: backend.discoveryPending, unavailableReason: backend.unavailableReason, accountType: backend.account?.type, serverName: backend.serverName, serverVersion: backend.serverVersion, modelCount: backend.launchpadOptions?.models?.length, modelIds: backend.launchpadOptions?.models?.map((model) => model.id), capabilities: backend.capabilities, tokenMiser: backend.tokenMiser },
      configError: settings.configError,
      tokenMiserSettings: { enabled: settings.experimental?.tokenMiserEnabled, defaultEnabled: settings.experimental?.tokenMiserDefaultEnabled },
      runtime: settings.runtime,
      selectedCommand: settings.models?.codex?.discovery?.selectedCommand,
      discoveryError: settings.models?.codex?.discovery?.error,
    };
    atomicJson(path.join(output, "readiness-pending.json"), redact(result.readiness));
    if (backend?.available && backend.account?.type && backend.launchpadOptions?.models?.length && settings.runtime?.tokenMiser?.managedCodex?.state === "ready"
      && (!input.tokenMiser || settings.runtime?.tokenMiser?.activation?.state === "active")) break;
    if (Date.now() > readyDeadline || stopReason) throw new Error("Backend readiness deadline exceeded");
    await new Promise((r) => setTimeout(r, 1000));
  } while (true);
  assertReady(backend, settings, input, runtime, { deferInterruptProbe: true });
  result.readiness = { backend: { serverName: backend.serverName, serverVersion: backend.serverVersion, methods: backend.methods, launchpadOptions: backend.launchpadOptions, tokenMiser: backend.tokenMiser }, runtime: settings.runtime, tokenMiserSettings: { enabled: settings.experimental?.tokenMiserEnabled, defaultEnabled: settings.experimental?.tokenMiserDefaultEnabled }, selectedCommand: settings.models.codex.discovery.selectedCommand };
  if (stopReason) throw new Error("Stopped before dispatch");
  {
    if (stopReason) throw new Error("Stopped before dispatch");
    const registered = await call("registerDirectoryFromDisk", { path: input.cwd, preferredBackend: "codex" });
    if (!registered.ok) throw new Error("Task directory registration failed");
    const common = { backend: "codex", executionMode: "full-access", model: input.model, reasoningEffort: input.reasoningEffort, serviceTier: input.serviceTier, fastMode: false };
    const thread = await call("startThread", { ...common, cwd: input.cwd, mcpConnectionIds: [], mcpProviderServersEnabled: false });
    result.threadId = thread.threadId;
    persist();
    const toggle = await call("setThreadTokenMiser", { backend: "codex", threadId: result.threadId, enabled: input.tokenMiser });
    const view = await call("readThread", { backend: "codex", threadId: result.threadId });
    if (toggle.tokenMiserEnabled !== input.tokenMiser || view.tokenMiserEnabled !== input.tokenMiser) throw new Error("Thread Token Miser mismatch");
    result.effectiveTokenMiser = view.tokenMiserEnabled;
    const summary = (await call("listThreads", { backend: "codex" })).threads.find((entry) => entry.id === result.threadId);
    if (summary?.model !== input.model || summary.reasoningEffort !== input.reasoningEffort || summary.executionMode !== "full-access" || summary.fastMode === true || (summary.serviceTier && !["default", "standard"].includes(summary.serviceTier))) throw new Error("Effective thread model/effort/access mismatch");
    result.effectiveModelSettings = { model: summary.model, reasoningEffort: summary.reasoningEffort, serviceTier: summary.serviceTier, fastMode: summary.fastMode, executionMode: summary.executionMode };
    result.readiness.interruptProbe = await probeInterrupt(call, result.threadId);
    assertReady(backend, settings, input, runtime, { interruptVerified: result.readiness.interruptProbe.supported });
    atomicJson(path.join(output, "ready.json"), redact(result.readiness));
    if (input.preflightOnly) {
      result.status = "completed";
      result.preflightOnly = true;
    } else {
      if (stopReason) throw new Error("Stopped before dispatch");
      await dispatchTurn({ call, result, persist, request: { ...common, threadId: result.threadId, input: [{ type: "text", text: input.prompt }] } });
      const outcome = await waitForOutcome({
        threadId: result.threadId, turnId: result.turnId, drain,
        read: () => call("readThread", { backend: "codex", threadId: result.threadId }),
        onEvent: (event) => appendFileSync(path.join(output, "rollout.jsonl"), JSON.stringify(redact(event)) + "\n", { mode: 0o600 }),
        onUsage: async (current) => {
          Object.assign(result, await observeFamilyBudget(call, { backend: "codex", threadId: result.threadId }, current));
          return budgetStop(input, result.observed);
        },
        stop: () => stopReason,
        pause: () => new Promise((resolve) => setTimeout(resolve, 500)),
      });
      result.status = ["input_required", "unpriced_usage"].includes(outcome) ? "failed" : outcome;
      if (result.status !== "completed") {
        result.stopReason = outcome;
        await call("interruptTurn", { backend: "codex", threadId: result.threadId, turnId: result.turnId }).catch(() => undefined);
      }
      const finalView = await call("readThread", { backend: "codex", threadId: result.threadId });
      result.pricing = finalView.pricing;
      result.toolAccounting = finalView.toolAccounting;
      result.tokenMiserUsage = await call("readTokenMiserUsage");
      result.answer = finalView.replay?.lastAssistantMessage;
      atomicJson(path.join(output, "thread.json"), redact(finalView));
    }
  }
} catch (error) {
  result.status = errorStatus(result, stopReason);
  if (stopReason) result.stopReason ??= stopReason;
  result.error = redact(error.message);
} finally {
  clearTimeout(watchdog);
  if (app) {
    if (result.status !== "completed" && result.threadId && result.turnId && call) await call("interruptTurn", { backend: "codex", threadId: result.threadId, ...(result.turnId ? { turnId: result.turnId } : {}) }).catch(() => undefined);
    try { await deadlineCall(app.close(), 15_000); result.cleanup = "graceful"; }
    catch { app.process().kill("SIGKILL"); result.cleanup = "forced"; if (result.status === "completed") result.status = "failed"; }
  }
  for (const unsubscribe of logSubscriptions) unsubscribe();
  if (logFd !== undefined) closeSync(logFd);
  if (input && claim && !claim.prior) {
    try { await exportProtocol(path.join(input.profileDir, "protocol")); } catch (error) { result.artifactError = redact(error.message); }
    if (result.baseCommit) {
      try {
        writeFileSync(path.join(output, "patch.diff"), redact(git(["diff", "--binary", result.baseCommit])), { mode: 0o600 });
        const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
        // Sanitize new files before archiving; do not mutate the task index or
        // dereference symlinks into auth/profile/verifier mounts.
        if (untracked) {
          const staging = mkdtempSync(path.join(output, ".export-"));
          try {
            for (const name of untracked.split("\0").filter(Boolean)) {
              const target = path.resolve(staging, name);
              if (!target.startsWith(staging + path.sep)) throw new Error("Unsafe artifact path");
              const source = path.join(input.cwd, name);
              const info = lstatSync(source);
              mkdirSync(path.dirname(target), { recursive: true });
              if (info.isSymbolicLink()) symlinkSync(redact(readlinkSync(source)), target);
              else if (info.isFile()) writeFileSync(target, Buffer.from(redact(readFileSync(source).toString("latin1")), "latin1"), { mode: info.mode & 0o777 });
              else throw new Error("Unsupported artifact file type");
            }
            execFileSync("tar", ["-C", staging, "--null", "-T", "-", "-czf", path.join(output, "untracked.tar.gz")], { input: untracked });
          } finally { rmSync(staging, { recursive: true, force: true }); }
        }
      } catch (error) { result.artifactError = redact(error.message); }
    }
    result.finishedAt = new Date().toISOString();
    if (result.artifactError && result.status === "completed") result.status = "failed";
    result.exitCode = EXIT[result.status] ?? 1;
    persist();
    atomicJson(path.join(output, "result.json"), redact(result));
  }
}
console.log(JSON.stringify({ runId: input?.runId, status: result.status, exitCode: result.exitCode, error: result.error }));
process.exit(result.exitCode ?? 2);
