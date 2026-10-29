import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The wrapper's job is ordering under signals: keep the step alive until
// Playwright's whole process group exits, and on SIGTERM kill Electron's main
// before its helpers. These tests drive it with real signals and stand-in
// `sleep` processes whose argv[0] is an Electron bundle path, so nothing here
// launches Electron.
const scriptPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "macos-e2e-run-lane.sh",
);

const BUNDLE =
  "PwrAgent/node_modules/.pnpm/electron@44.9.3/node_modules/electron/dist/Electron.app";

let workDir;
let scope;
const started = [];

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "macos-e2e-run-lane-test-"));
  scope = path.join(workDir, "_work", "PwrAgent");
  mkdirSync(scope, { recursive: true });
});

afterAll(() => {
  for (const child of started) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(workDir, { force: true, recursive: true });
});

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start the wrapper around `bash -c <script>` and collect its output. */
function startLane(script, env = {}) {
  const lane = spawn("bash", [scriptPath, "bash", "-c", script], {
    env: { ...process.env, RUNNER_WORKSPACE: scope, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  started.push(lane);
  const run = { lane, output: "" };
  lane.stdout.on("data", (chunk) => (run.output += chunk));
  lane.stderr.on("data", (chunk) => (run.output += chunk));
  run.exit = new Promise((resolve) => lane.on("exit", (code) => resolve(code)));
  return run;
}

/** A `sleep` whose argv[0] reads as `<root>/<relative>`, as Electron's does. */
function fakeProcess(root, relative) {
  const child = spawn("bash", ["-c", 'exec -a "$0" sleep 60', path.join(root, relative)], {
    stdio: "ignore",
  });
  started.push(child);
  return child;
}

describe.skipIf(process.platform === "win32")("macos-e2e-run-lane.sh", () => {
  it("passes the command's exit status through", async () => {
    const run = startLane("exit 3");
    expect(await run.exit).toBe(3);
  });

  it("does not wait for a lingering group member when nothing was cancelled", async () => {
    const begun = Date.now();
    const run = startLane("sleep 6 & exit 0");
    expect(await run.exit).toBe(0);
    expect(Date.now() - begun).toBeLessThan(4_000);
  });

  it("refuses to run without a workspace scope", async () => {
    const run = startLane("exit 0", { RUNNER_WORKSPACE: "", GITHUB_WORKSPACE: "" });
    expect(await run.exit).toBe(2);
    expect(run.output).toContain("refusing to guess a kill scope");
  });

  it("waits for the whole command group after SIGINT, not just the command", async () => {
    // The command exits on SIGINT at once, as pnpm does. A process it started
    // keeps working for a second first, as Playwright does.
    const ready = path.join(workDir, "int-ready");
    const finished = path.join(workDir, "int-finished");
    const late = path.join(workDir, "late.cjs");
    writeFileSync(
      late,
      [
        "const fs = require('fs');",
        "process.on('SIGINT', () => setTimeout(() => {",
        `  fs.writeFileSync(${JSON.stringify(finished)}, '');`,
        "  process.exit(0);",
        "}, 1000));",
        `fs.writeFileSync(${JSON.stringify(ready)}, '');`,
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const run = startLane(
      `"${process.execPath}" "${late}" & trap 'exit 130' INT; while :; do sleep 0.05; done`,
    );
    await waitFor(() => existsSync(ready));

    run.lane.kill("SIGINT");

    expect(await run.exit).toBe(130);
    expect(existsSync(finished)).toBe(true);
  });

  it("kills this lane's Electron main before its helpers on SIGTERM", async () => {
    const main = fakeProcess(scope, `${BUNDLE}/Contents/MacOS/Electron`);
    const helper = fakeProcess(
      scope,
      `${BUNDLE}/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`,
    );
    // A sibling workspace that only shares the prefix is out of scope.
    const foreign = fakeProcess(`${scope}2`, `${BUNDLE}/Contents/MacOS/Electron`);
    const ready = path.join(workDir, "term-ready");
    const run = startLane(`touch "${ready}"; while :; do sleep 0.05; done`);
    await waitFor(() => existsSync(ready));
    await waitFor(() => [main, helper, foreign].every((child) => alive(child.pid)));

    run.lane.kill("SIGTERM");

    expect(await run.exit).toBe(143);
    await waitFor(() => !alive(main.pid) && !alive(helper.pid));
    expect(alive(foreign.pid)).toBe(true);
    const mainAt = run.output.indexOf(`SIGKILL Electron main pid(s) ${main.pid} `);
    const helperAt = run.output.indexOf(`SIGKILL Electron helper pid(s) ${helper.pid} `);
    expect(mainAt).toBeGreaterThanOrEqual(0);
    expect(helperAt).toBeGreaterThan(mainAt);
  });
});
