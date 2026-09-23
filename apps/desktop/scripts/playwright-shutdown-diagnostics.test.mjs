import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { once } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const fromPlaywright = createRequire(require.resolve("@playwright/test"));
const cli = path.join(path.dirname(fromPlaywright.resolve("playwright/package.json")), "cli.js");
const core = fromPlaywright.resolve("playwright-core/lib/coreBundle");
const diagnostics = new URL("./playwright-shutdown-diagnostics.mjs", import.meta.url).href;
const roots = [];
const activeProbes = new Set();
const POST_READY_CLI_TIMEOUT_MS = 10_000;

afterEach(async () => {
  await Promise.all([...activeProbes].map(stopProbe));
});

afterAll(async () => {
  await Promise.all([...activeProbes].map(stopProbe));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workerStarted(output) {
  const directory = path.join(output, "worker-shutdown");
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { recursive: true })
    .filter((file) => path.basename(file) === "timeline.jsonl")
    .some((file) => readFileSync(path.join(directory, file), "utf8").includes('"kind":"worker-start"'));
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

function startProbe(args, options) {
  const controller = new AbortController();
  let child;
  const result = new Promise((resolve) => {
    child = execFile(process.execPath, args, { ...options, signal: controller.signal }, (error, stdout, stderr) => {
      resolve(error ? { code: error.code, stderr, stdout } : { code: 0, stderr, stdout });
    });
  });
  const probe = { child, controller, result };
  activeProbes.add(probe);
  void result.finally(() => activeProbes.delete(probe));
  return probe;
}

async function stopProbe(probe) {
  const exited = () => probe.child.exitCode !== null || probe.child.signalCode !== null;
  if (exited()) return;
  probe.controller.abort();
  await Promise.race([
    once(probe.child, "close").catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 500)),
  ]);
  if (!exited()) probe.child.kill("SIGKILL");
}

async function probe(mode) {
  mkdirSync(path.join(desktop, ".local"), { recursive: true });
  const root = mkdtempSync(path.join(desktop, ".local/shutdown-probe-"));
  roots.push(root);
  const output = path.join(root, "results");
  const descendantPidFile = path.join(root, "descendant.pid");
  const childSource = mode === "pipe"
    ? `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 1, 2] }); require('node:fs').writeFileSync(${JSON.stringify(descendantPidFile)}, String(child.pid)); process.exit(0);`
    : "setTimeout(() => {}, 10000)";
  writeFileSync(path.join(root, "playwright.config.mjs"), `
    import playwright from ${JSON.stringify(pathToFileURL(require.resolve("@playwright/test")).href)};
    const { test } = playwright;
    import { installShutdownDiagnostics } from ${JSON.stringify(diagnostics)};
    installShutdownDiagnostics({ outputDir: ${JSON.stringify(output)}, currentTest: () => test.info(), captureAfterMs: 100 });
    export default { testDir: '.', testMatch: '*.spec.cjs', outputDir: ${JSON.stringify(output)}, timeout: 5000, workers: 1, retries: 0, reporter: 'list' };
  `);
  writeFileSync(path.join(root, "probe.spec.cjs"), `
    const { test: base, expect } = require(${JSON.stringify(require.resolve("@playwright/test"))});
    const { utils } = require(${JSON.stringify(core)});
    const test = ${mode === "fixture" ? `base.extend({ stuck: [async ({}, use) => { await use(); await new Promise(() => {}); }, { scope: 'worker', auto: true }] })` : "base"};
    test('identifiable shutdown probe', async () => {
      ${mode === "fixture" ? "expect(true).toBe(true);" : `
      const launched = await utils.launchProcess({
        command: process.execPath, args: ['-e', ${JSON.stringify(childSource)}],
        env: { ...process.env }, stdio: 'pipe', tempDirectories: [],
        log() {}, onExit() {},
        attemptToGracefullyClose: () => ${mode === "pipe" ? "Promise.resolve()" : "new Promise(() => {})"},
      });
      expect(launched.launchedProcess.pid).toBeGreaterThan(0);
      ${mode === "pipe" ? "await new Promise(resolve => launched.launchedProcess.once('exit', resolve));" : ""}
      ${mode === "healthy" ? "await launched.kill();" : ""}
      `}
    });
  `);
  const started = startProbe([cli, "test", "-c", path.join(root, "playwright.config.mjs")], {
    cwd: desktop,
    env: { ...process.env, PWRAGENT_E2E_WORKER_DIAGNOSTICS: "1", SHUTDOWN_PROBE_SECRET: "must-not-appear-in-artifacts" },
    maxBuffer: 1024 * 1024,
  });
  const readiness = waitForWorkerStart(root, output);
  let completionTimer;
  let timedOut = false;
  let result;
  try {
    // Startup is governed by the test's own deadline and afterEach owns the
    // child if it fails. Once the worker has emitted its readiness event, the
    // probe gets a separate bounded completion window around Playwright's
    // five-second cleanup timeout.
    await Promise.race([
      readiness.promise,
      started.result.then((completed) => {
        if (workerStarted(output)) return completed;
        throw new Error(`Playwright exited before the worker shutdown recorder became ready.\n${completed.stdout}${completed.stderr}`);
      }),
    ]);
    completionTimer = setTimeout(() => {
      timedOut = true;
      started.controller.abort();
    }, POST_READY_CLI_TIMEOUT_MS);
    result = await started.result;
    if (timedOut) throw new Error("Playwright did not exit after the worker shutdown recorder became ready.");
  } finally {
    clearTimeout(completionTimer);
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
  return { ...result, artifacts, snapshots: artifacts.filter(({ file }) => file.includes("snapshot-")).map(({ text }) => JSON.parse(text)) };
}

describe("real Playwright worker shutdown diagnostics", () => {
  it("terminates a probe that stalls before worker readiness", async () => {
    const started = startProbe(["-e", "setInterval(() => {}, 1_000)"], {
      cwd: desktop,
      maxBuffer: 1024 * 1024,
    });
    await stopProbe(started);
    await started.result;
    expect(started.child.exitCode !== null || started.child.signalCode !== null).toBe(true);
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
    const tree = JSON.parse(result.artifacts.find(({ file }) => file.endsWith("process-tree.json")).text);
    expect(tree.error).toBeUndefined();
    expect(tree.processes.some(({ pid }) => pid === pending.pid)).toBe(true);
  }, 20_000);

  it("distinguishes a worker fixture hang from process cleanup", async () => {
    const result = await probe("fixture");
    expect(result.code, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("1 passed");
    expect(result.snapshots.find(({ reason }) => reason === "slow-worker-cleanup").phase).toBe("worker-fixtures");
  }, 20_000);

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
  }, 20_000);

  it("leaves healthy cleanup green without expensive snapshots", async () => {
    const result = await probe("healthy");
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.snapshots).toHaveLength(0);
    const timeline = result.artifacts.find(({ file }) => file.endsWith("timeline.jsonl")).text;
    expect(timeline).toContain('"kind":"worker-end","failed":false');
  }, 20_000);
});
