import { execFile } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it, onTestFailed } from "vitest";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const fromPlaywright = createRequire(require.resolve("@playwright/test"));
const cli = path.join(path.dirname(fromPlaywright.resolve("playwright/package.json")), "cli.js");
const core = fromPlaywright.resolve("playwright-core/lib/coreBundle");
const diagnostics = new URL("./playwright-shutdown-diagnostics.mjs", import.meta.url).href;
const roots = [];
const activeProbes = new Set();
// A probe starts two cold Node processes, the Playwright CLI and its worker,
// and each loads Playwright and the generated config before the worker is
// ready. On macOS that took 0.5s idle, up to 3.6s beside a full unit shard and
// 12.6s at a load average of 36 on ten cores. The shutdown these tests exercise
// did not vary: Playwright's five-second teardown deadline measured 5.0-5.1s
// throughout. Cold start therefore has its own budget, and the shutdown budget
// starts from the worker's recorded readiness.
const COLD_START_BUDGET_MS = 30_000;
const SHUTDOWN_BUDGET_MS = 20_000;
// Vitest's deadline is a backstop behind the two named budgets.
const PROBE_TEST_TIMEOUT_MS = COLD_START_BUDGET_MS + SHUTDOWN_BUDGET_MS + 5_000;

afterEach(async () => {
  // Preserve the state at the outer deadline, before abort changes the evidence.
  for (const probe of activeProbes) probe.capture("before-cleanup");
  await Promise.all([...activeProbes].map(stopProbe));
});

afterAll(async () => {
  await Promise.all([...activeProbes].map(stopProbe));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// The worker's own readiness time, in epoch milliseconds, or undefined.
function workerStartedAt(output) {
  const directory = path.join(output, "worker-shutdown");
  if (!existsSync(directory)) return undefined;
  for (const file of readdirSync(directory, { recursive: true })) {
    if (path.basename(file) !== "timeline.jsonl") continue;
    // Only newline-terminated lines are complete; the worker may be appending.
    const start = readFileSync(path.join(directory, file), "utf8").split("\n").slice(0, -1)
      .find((line) => line.includes('"kind":"worker-start"'));
    if (start) return Date.parse(JSON.parse(start).time);
  }
  return undefined;
}

function workerStarted(output) {
  return workerStartedAt(output) !== undefined;
}

// Rejects with the named budget if the work outlives it. The probe's state is
// captured first, so abort and cleanup cannot replace the evidence.
function withinBudget(probe, promise, ms, message) {
  let timer;
  // The losing promise can still reject during cleanup; that is not a new failure.
  promise.catch(() => {});
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      probe.capture("before-cleanup");
      reject(new Error(message));
    }, Math.max(0, ms));
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

function waitForWorkerStart(root, output) {
  let watcher;
  const close = () => watcher?.close();
  const promise = new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (!workerStarted(output)) return;
        close();
        resolve();
      } catch (error) {
        close();
        reject(error);
      }
    };
    watcher = watch(root, { recursive: true }, check);
    check();
  });
  return { close, promise };
}

function createProbeRoot() {
  mkdirSync(path.join(desktop, ".local"), { recursive: true });
  const root = mkdtempSync(path.join(desktop, ".local/shutdown-probe-"));
  roots.push(root);
  return root;
}

function milestone(root, kind) {
  return `require('node:fs').appendFileSync(${JSON.stringify(path.join(root, "milestones.jsonl"))}, JSON.stringify({ kind: ${JSON.stringify(kind)}, pid: process.pid, time: new Date().toISOString() }) + '\\n');`;
}

function startProbe(args, options, root = createProbeRoot()) {
  const controller = new AbortController();
  const startedAt = performance.now();
  const events = [];
  const tails = { stdout: "", stderr: "" };
  const bytes = { stdout: 0, stderr: 0 };
  const note = (kind, details = {}) => {
    const event = { kind, time: new Date().toISOString(), elapsedMs: performance.now() - startedAt, ...details };
    events.push(event);
    if (existsSync(root)) appendFileSync(path.join(root, "parent.jsonl"), `${JSON.stringify(event)}\n`);
  };
  // Unlike spawn, this proves Node reached user code. Playwright's forked
  // workers inherit the preload, so each entry carries its own PID.
  const bootstrap = path.join(root, "bootstrap.cjs");
  writeFileSync(bootstrap, milestone(root, "node-start"));
  let child;
  note("exec-requested");
  const result = new Promise((resolve) => {
    child = execFile(process.execPath, ["--require", bootstrap, ...args], { ...options, signal: controller.signal }, (error, stdout, stderr) => {
      note("exec-callback", { code: error?.code ?? 0, signal: error?.signal });
      resolve(error ? { code: error.code, stderr, stdout } : { code: 0, stderr, stdout });
    });
  });
  child.once("spawn", () => note("spawn", { pid: child.pid }));
  child.on("error", (error) => note("error", { code: error.code }));
  child.once("exit", (code, signal) => note("exit", { code, signal }));
  child.once("close", (code, signal) => note("close", { code, signal }));
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (chunk) => {
      bytes[name] += Buffer.byteLength(chunk);
      tails[name] = (tails[name] + chunk.toString()).slice(-8192);
    });
    child[name].once("end", () => note(`${name}-end`));
    child[name].once("close", () => note(`${name}-close`));
  }
  const snapshot = () => ({
    pid: child.pid, elapsedMs: performance.now() - startedAt, node: process.version, platform: process.platform, arch: process.arch,
    exitCode: child.exitCode, signalCode: child.signalCode, events: [...events],
    stdio: ["stdout", "stderr"].map((name) => ({
      name, bytes: bytes[name], destroyed: child[name].destroyed,
      readableEnded: child[name].readableEnded,
      tail: tails[name].replaceAll("must-not-appear-in-artifacts", "[redacted]"),
    })),
  });
  const capture = (boundary) => {
    const file = path.join(root, `${boundary}.json`);
    // Late close events may follow afterAll's temporary-directory removal.
    // The first observation of a boundary wins; later cleanup passes reach
    // the same boundary after abort has changed the state.
    if (existsSync(root) && !existsSync(file)) writeFileSync(file, JSON.stringify(snapshot(), null, 2));
  };
  const probe = { child, controller, result, root, note, snapshot, capture };
  onTestFailed(() => {
    capture("after-cleanup");
    const destination = path.join(desktop, "test-results/unit-shutdown-probes", path.basename(root));
    // Keep the CI log bounded; full timelines and pipe tails are in the artifact.
    // Log before copying so a failed copy cannot also lose this summary.
    const beforeCleanup = path.join(root, "before-cleanup.json");
    const state = existsSync(beforeCleanup) ? JSON.parse(readFileSync(beforeCleanup, "utf8")) : snapshot();
    console.error(`[shutdown-probe] evidence=${destination}; boundary=${existsSync(beforeCleanup) ? "before-cleanup" : "completed"}; pid=${state.pid}; exit=${state.exitCode}; signal=${state.signalCode}; events=${state.events.map(({ kind }) => kind).join(",")}; pipes=${JSON.stringify(state.stdio.map(({ tail: _tail, ...pipe }) => pipe))}`);
    cpSync(root, destination, { recursive: true });
  });
  activeProbes.add(probe);
  void result.then(() => {
    activeProbes.delete(probe);
    capture("completed");
  });
  return probe;
}

async function stopProbe(probe) {
  // After an outer timeout, afterEach and probe()'s finally both stop the
  // probe. Keep the first stop's evidence and request one abort.
  const stopping = probe.controller.signal.aborted;
  if (!stopping) probe.capture("before-stop");
  const exited = () => probe.child.exitCode !== null || probe.child.signalCode !== null;
  if (exited()) return;
  if (!stopping) {
    probe.note("abort-requested");
    probe.controller.abort();
  }
  await Promise.race([
    once(probe.child, "close").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!exited()) probe.child.kill("SIGKILL");
}

async function probe(mode, { captureAfterMs = 100 } = {}) {
  const root = createProbeRoot();
  const output = path.join(root, "results");
  const descendantPidFile = path.join(root, "descendant.pid");
  const childSource = mode === "pipe"
    ? `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 1, 2] }); require('node:fs').writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid)); process.exit(0);`
    : "setTimeout(() => {}, 10000)";
  writeFileSync(path.join(root, "playwright.config.mjs"), `
    import playwright from ${JSON.stringify(pathToFileURL(require.resolve("@playwright/test")).href)};
    const { test } = playwright;
    import { installShutdownDiagnostics } from ${JSON.stringify(diagnostics)};
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    ${milestone(root, "config-evaluated")}
    installShutdownDiagnostics({ outputDir: ${JSON.stringify(output)}, currentTest: () => test.info(), captureAfterMs: ${captureAfterMs} });
    export default { testDir: '.', testMatch: '*.spec.cjs', outputDir: ${JSON.stringify(output)}, timeout: 5000, workers: 1, retries: 0, reporter: 'list' };
  `);
  writeFileSync(path.join(root, "probe.spec.cjs"), `
    const { test: base, expect } = require(${JSON.stringify(require.resolve("@playwright/test"))});
    const { utils } = require(${JSON.stringify(core)});
    ${milestone(root, "spec-evaluated")}
    const test = ${mode === "fixture" ? `base.extend({ stuck: [async ({}, use) => { await use(); await new Promise(() => {}); }, { scope: 'worker', auto: true }] })` : "base"};
    test('identifiable shutdown probe', async () => {
      ${milestone(root, "test-body")}
      ${mode === "fixture" ? "expect(true).toBe(true);" : `
      const launched = await utils.launchProcess({
        command: process.execPath, args: ['-e', ${JSON.stringify(childSource)}],
        env: { ...process.env }, stdio: 'pipe', tempDirectories: [],
        log() {}, onExit() {},
        attemptToGracefullyClose: () => ${mode === "pipe" ? "Promise.resolve()" : "new Promise(() => {})"},
      });
      expect(launched.launchedProcess.pid).toBeGreaterThan(0);
      ${milestone(root, "test-process-launched")}
      ${mode === "pipe" ? "await new Promise(resolve => launched.launchedProcess.once('exit', resolve));" : ""}
      ${mode === "healthy" ? "await launched.kill();" : ""}
      `}
      ${milestone(root, "test-body-end")}
    });
  `);
  const started = startProbe([cli, "test", "-c", path.join(root, "playwright.config.mjs")], {
    cwd: desktop,
    env: { ...process.env, PWRAGENT_E2E_WORKER_DIAGNOSTICS: "1", SHUTDOWN_PROBE_SECRET: "must-not-appear-in-artifacts" },
    maxBuffer: 1024 * 1024,
  }, root);
  const readiness = waitForWorkerStart(root, output);
  let result;
  try {
    // Cold start ends at worker readiness; the finally block owns the child if
    // either budget expires.
    await withinBudget(started, Promise.race([
      readiness.promise,
      started.result.then((completed) => {
        if (workerStarted(output)) return completed;
        throw new Error(`Playwright exited before the worker shutdown recorder became ready.\n${completed.stdout}${completed.stderr}`);
      }),
    ]), COLD_START_BUDGET_MS, `Playwright did not reach worker readiness within the ${COLD_START_BUDGET_MS}ms cold-start budget.`);
    started.note("worker-ready-observed");
    // Measured from the worker's record, so a late file notification cannot
    // extend the shutdown budget.
    const readyAt = workerStartedAt(output) ?? Date.now();
    result = await withinBudget(started, started.result, SHUTDOWN_BUDGET_MS - (Date.now() - readyAt),
      `Playwright did not finish within ${SHUTDOWN_BUDGET_MS}ms of worker readiness.`);
  } finally {
    readiness.close();
    await stopProbe(started);
    if (existsSync(descendantPidFile)) {
      try { process.kill(Number(readFileSync(descendantPidFile, "utf8")), "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  const diagnosticsRoot = path.join(output, "worker-shutdown");
  expect(existsSync(diagnosticsRoot), result.stdout + result.stderr).toBe(true);
  const files = readdirSync(diagnosticsRoot, { recursive: true }).filter((file) => /\.(json|jsonl)$/.test(file));
  const artifacts = files.map((file) => ({ file, text: readFileSync(path.join(diagnosticsRoot, file), "utf8") }));
  expect(artifacts.map(({ text }) => text).join("\n")).not.toContain("must-not-appear-in-artifacts");
  expect(artifacts.find(({ file }) => file.endsWith("timeline.jsonl"))?.text).toContain('"kind":"worker-start"');
  return { ...result, parent: started.snapshot(), artifacts, snapshots: artifacts.filter(({ file }) => file.includes("snapshot-")).map(({ text }) => JSON.parse(text)) };
}

describe("real Playwright worker shutdown diagnostics", () => {
  it("does not report worker readiness from a controller with an inherited worker index", async () => {
    const root = createProbeRoot();
    const output = path.join(root, "results");
    writeFileSync(path.join(root, "playwright.config.mjs"), `
      import { installShutdownDiagnostics } from ${JSON.stringify(diagnostics)};
      installShutdownDiagnostics({ outputDir: ${JSON.stringify(output)}, currentTest: () => undefined });
      export default { testDir: '.', testMatch: '*.spec.cjs', outputDir: ${JSON.stringify(output)}, reporter: 'list' };
    `);
    writeFileSync(path.join(root, "probe.spec.cjs"), `
      const { test } = require(${JSON.stringify(require.resolve("@playwright/test"))});
      test('listed but not run', async () => {});
    `);
    const started = startProbe([cli, "test", "--list", "-c", path.join(root, "playwright.config.mjs")], {
      cwd: desktop,
      env: { ...process.env, TEST_WORKER_INDEX: "7", PWRAGENT_E2E_WORKER_DIAGNOSTICS: "1" },
      maxBuffer: 1024 * 1024,
    }, root);
    // Listing starts no worker, so the whole run is cold start.
    const result = await withinBudget(started, started.result, COLD_START_BUDGET_MS,
      `Playwright did not list tests within the ${COLD_START_BUDGET_MS}ms cold-start budget.`);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(existsSync(path.join(output, "worker-shutdown"))).toBe(false);
  }, COLD_START_BUDGET_MS + 5_000);

  it("terminates a probe that stalls before worker readiness", async () => {
    const started = startProbe(["-e", "setInterval(() => {}, 1_000)"], {
      cwd: desktop,
      maxBuffer: 1024 * 1024,
    });
    await once(started.child, "spawn");
    expect(started.snapshot()).toMatchObject({ exitCode: null, signalCode: null });
    expect(started.snapshot().events.map(({ kind }) => kind)).toEqual(["exec-requested", "spawn"]);
    await stopProbe(started);
    await started.result;
    expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true);
    expect(started.snapshot().events.map(({ kind }) => kind)).toContain("close");
  });

  it("names the process, originating test and unresolved close before Playwright times out", async () => {
    const result = await probe("process");
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("1 passed");
    expect(result.stdout).toContain("Worker teardown timeout");
    const snapshot = result.snapshots.find(({ reason }) => reason === "slow-worker-cleanup");
    expect(snapshot.phase).toBe("registered-processes");
    const pending = snapshot.processes.find(({ registered }) => registered);
    expect(pending.owner.title).toBe("identifiable shutdown probe");
    expect(pending.owner.file).toContain("probe.spec.cjs");
    expect(pending.pid).toBeGreaterThan(0);
    expect(pending.stage).toBe("attempt-to-gracefully-close");
    expect(pending.launchStack).toContain("launchProcess");
    expect(snapshot.resources.some(({ type }) => type === "PROCESSWRAP")).toBe(true);
    expect(snapshot.report.libuv.length).toBeGreaterThan(0);
    const artifact = result.artifacts.find(({ file }) => file.endsWith("process-tree.json"));
    expect(artifact, result.stdout + result.stderr).toBeDefined();
    const tree = JSON.parse(artifact.text);
    // The probe root is deleted after the run, so this message is the only
    // copy of the failure classification a CI log keeps.
    const record = JSON.stringify(tree);
    if (tree.status === "interrupted") {
      // The worker owns its exit deadline. A pending asynchronous query must
      // report that boundary explicitly, rather than disappear with the worker.
      expect(tree, record).toMatchObject({ reason: "worker-exit" });
      expect(tree.workerExitCode, record).toBeTypeOf("number");
      expect(tree.elapsedMs, record).toBeGreaterThanOrEqual(0);
      expect(tree.processes, record).toBeUndefined();
    } else if (tree.killed) {
      // The query is bounded, not guaranteed. Windows runners measured
      // 0.6-1.1s against the 3s bound, yet a loaded runner can still reach
      // it. A kill at the bound must say so; any other failure is a defect.
      expect(tree, record).toMatchObject({ signal: "SIGTERM", code: null });
      expect(tree.elapsedMs, record).toBeGreaterThanOrEqual(tree.timeoutMs);
    } else {
      expect(tree.error, record).toBeUndefined();
      expect(tree.processes.some(({ pid }) => pid === pending.pid)).toBe(true);
    }
  }, PROBE_TEST_TIMEOUT_MS);

  it("distinguishes a worker fixture hang from process cleanup", async () => {
    const result = await probe("fixture");
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("1 passed");
    expect(result.snapshots.find(({ reason }) => reason === "slow-worker-cleanup").phase).toBe("worker-fixtures");
  }, PROBE_TEST_TIMEOUT_MS);

  it("records an interrupted query when capture starts at the worker exit boundary", async () => {
    // Trigger capture only from workerEnd after the existing teardown deadline.
    // The asynchronous tree query cannot finish before this worker exits.
    const result = await probe("process", { captureAfterMs: 60_000 });
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("Worker teardown timeout");
    expect(result.snapshots.some(({ reason }) => reason === "worker-cleanup-failed")).toBe(true);
    const artifact = result.artifacts.find(({ file }) => file.endsWith("process-tree.json"));
    expect(artifact, result.stdout + result.stderr).toBeDefined();
    const tree = JSON.parse(artifact.text);
    expect(tree).toMatchObject({ status: "interrupted", reason: "worker-exit" });
    expect(tree.workerExitCode).toBeTypeOf("number");
    expect(tree.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(tree.processes).toBeUndefined();
    expect(tree.queryPid).toBeGreaterThan(0);
    await expect.poll(() => {
      try {
        process.kill(tree.queryPid, 0);
        return false;
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
        return true;
      }
    }).toBe(true);
  }, PROBE_TEST_TIMEOUT_MS);

  // This fixture relies on POSIX inherited-fd lifetime: the grandchild keeps
  // the worker's pipe open after its parent exits. Windows CI closes it and
  // exits zero, so this is not a Windows hang reproduction. The process and
  // fixture timeout probes above exercise actual failure capture on Windows.
  it.skipIf(process.platform === "win32")("captures an exited POSIX parent whose descendant still holds the stdio pipes", async () => {
    const result = await probe("pipe");
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("1 passed");
    const snapshot = result.snapshots.find(({ reason }) => reason === "slow-worker-cleanup");
    const pending = snapshot.processes.find(({ registered }) => registered);
    expect(pending.exitObserved).toBe(true);
    expect(pending.closeObserved).toBe(false);
    expect(pending.exitCode).toBe(0);
    expect(pending.stage).toBe("wait-for-process-close-and-cleanup");
    expect(pending.stdio.some(({ fd, destroyed }) => fd === 1 && !destroyed)).toBe(true);
  }, PROBE_TEST_TIMEOUT_MS);

  it("leaves healthy cleanup green without expensive snapshots", async () => {
    const result = await probe("healthy");
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.snapshots).toHaveLength(0);
    const events = result.parent.events.map(({ kind }) => kind);
    expect(events).toEqual(expect.arrayContaining(["spawn", "worker-ready-observed", "exit", "close", "exec-callback"]));
    expect(events.indexOf("exit")).toBeLessThan(events.indexOf("close"));
    expect(result.parent.stdio.every(({ destroyed, readableEnded }) => destroyed && readableEnded)).toBe(true);
    const timeline = result.artifacts.find(({ file }) => file.endsWith("timeline.jsonl")).text;
    expect(timeline).toContain('"kind":"worker-end","failed":false');
  }, PROBE_TEST_TIMEOUT_MS);
});
