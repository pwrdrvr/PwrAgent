import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("..", import.meta.url));
const fromPlaywright = createRequire(require.resolve("@playwright/test"));
const cli = path.join(path.dirname(fromPlaywright.resolve("playwright/package.json")), "cli.js");
const core = fromPlaywright.resolve("playwright-core/lib/coreBundle");
const diagnostics = new URL("./playwright-shutdown-diagnostics.mjs", import.meta.url).href;
const roots = [];
const run = promisify(execFile);

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

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
  const result = await run(process.execPath, [cli, "test", "-c", path.join(root, "playwright.config.mjs")], {
    cwd: desktop,
    env: { ...process.env, PWRAGENT_E2E_WORKER_DIAGNOSTICS: "1", SHUTDOWN_PROBE_SECRET: "must-not-appear-in-artifacts" },
    timeout: 15_000, maxBuffer: 1024 * 1024,
  }).then((value) => ({ ...value, code: 0 }), (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }));
  if (existsSync(descendantPidFile)) {
    try { process.kill(Number(readFileSync(descendantPidFile, "utf8")), "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  const diagnosticsRoot = path.join(output, "worker-shutdown");
  expect(existsSync(diagnosticsRoot), result.stdout + result.stderr).toBe(true);
  const files = readdirSync(diagnosticsRoot, { recursive: true }).filter((file) => /\.(json|jsonl)$/.test(file));
  const artifacts = files.map((file) => ({ file, text: readFileSync(path.join(diagnosticsRoot, file), "utf8") }));
  expect(artifacts.map(({ text }) => text).join("\n")).not.toContain("must-not-appear-in-artifacts");
  return { ...result, artifacts, snapshots: artifacts.filter(({ file }) => file.includes("snapshot-")).map(({ text }) => JSON.parse(text)) };
}

describe("real Playwright worker shutdown diagnostics", () => {
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

  it("captures an exited parent whose descendant still holds the stdio pipes", async () => {
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
