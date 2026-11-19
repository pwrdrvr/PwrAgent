import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { compileAppIcon } from "./lib/compile-app-icon.mjs";

const require = createRequire(import.meta.url);
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const iconTest = "apps/desktop/scripts/app-icon.test.mjs";
const blockingActool = '#!/bin/sh\nprintf "%s\\n" "$$" > "$ACTOOL_ORACLE_PID"\nexec /bin/sleep 60\n';

async function waitForActoolPid(pidFile) {
  const signal = AbortSignal.timeout(10_000);
  for (;;) {
    const contents = await readFile(pidFile, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    const pid = Number.parseInt(contents, 10);
    if (pid > 0) return pid;
    await delay(20, undefined, { signal });
  }
}

function expectReaped(pid) {
  return vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(
    expect.objectContaining({ code: "ESRCH" }),
  ));
}

function killIfRunning(pid) {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (error.code !== "ESRCH") throw error; }
}

// Observe the real suite through Vitest with recording stand-ins on PATH.
// Collection and ordinary unit runs must work without starting Xcode. An
// explicitly required compile must attempt actool and fail if it is unusable.
it.skipIf(process.platform !== "darwin").each([
  { args: ["list", "--no-static-parse"], required: "1", commands: "", code: 0, output: "emits Assets.car and the legacy Icon.icns" },
  { args: ["run"], required: "", commands: "", code: 0, output: "5 passed" },
  { args: ["run"], required: "1", commands: "actool --version\n", code: 1, output: "Failed to check actool version" },
])("owns native commands in Vitest $args with require-actool='$required'", async (expected) => {
  const fixture = await mkdtemp(join(tmpdir(), "pwragent-icon-ownership-"));
  try {
    const config = join(fixture, "vitest.config.mjs");
    const log = join(fixture, "invocations");
    await writeFile(config, "export default {};\n");
    await writeFile(log, "");
    const recordInvocation = '#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*" >> "$ACTOOL_ORACLE_LOG"\nexit 1\n';
    await Promise.all(["xcrun", "actool", "plutil", "iconutil"].map((tool) =>
      writeFile(join(fixture, tool), recordInvocation, { mode: 0o755 })));
    const result = await promisify(execFile)(process.execPath, [
      vitest, ...expected.args, "--config", config, iconTest,
    ], {
      cwd: root,
      env: {
        ...process.env,
        PATH: [fixture, process.env.PATH].join(delimiter),
        ACTOOL_ORACLE_LOG: log,
        PWRAGENT_REQUIRE_ACTOOL: expected.required,
      },
      timeout: 15_000,
      killSignal: "SIGKILL",
    }).then(({ stdout }) => ({ code: 0, output: stdout }), (error) => ({
      code: error.code,
      output: error.stdout + error.stderr,
    }));
    expect(await readFile(log, "utf8")).toBe(expected.commands);
    expect(result.code, result.output).toBe(expected.code);
    expect(result.output).toContain(expected.output);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);

it.skipIf(process.platform !== "darwin")("reaps a stuck actool when the required compile reaches its deadline", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pwragent-icon-deadline-"));
  const outputDir = join(fixture, "output");
  const pidFile = join(fixture, "actool.pid");
  try {
    await mkdir(outputDir);
    await writeFile(join(fixture, "actool"), blockingActool, { mode: 0o755 });
    vi.stubEnv("PATH", [fixture, process.env.PATH].join(delimiter));
    vi.stubEnv("ACTOOL_ORACLE_PID", pidFile);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const compiled = compileAppIcon(join(root, "apps/desktop/build/icon.icon"), outputDir, 100);
    const settled = compiled.catch(() => {});
    let pid;
    try {
      pid = await waitForActoolPid(pidFile);
      expect(process.kill(pid, 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await expect(compiled).rejects.toThrow("actool icon compilation timed out after 100 ms");
      vi.useRealTimers();
      await expectReaped(pid);
      pid = undefined;
    } finally {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
      await settled;
      if (pid) killIfRunning(pid);
    }
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  }
}, 15_000);

it.skipIf(process.platform !== "darwin")("reaps a stuck actool when Vitest receives Ctrl-C", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "pwragent-icon-cancel-"));
  try {
    const config = join(fixture, "vitest.config.mjs");
    const pidFile = join(fixture, "actool.pid");
    await writeFile(config, "export default { test: { pool: 'forks' } };\n");
    await writeFile(join(fixture, "actool"), blockingActool, { mode: 0o755 });
    const runner = spawn(process.execPath, [vitest, "run", "--config", config, iconTest], {
      cwd: root,
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        PATH: [fixture, process.env.PATH].join(delimiter),
        ACTOOL_ORACLE_PID: pidFile,
        PWRAGENT_REQUIRE_ACTOOL: "1",
        TMPDIR: fixture,
      },
    });
    const exited = once(runner, "exit", { signal: AbortSignal.timeout(15_000) });
    exited.catch(() => {});
    let pid;
    try {
      pid = await waitForActoolPid(pidFile);
      expect(process.kill(pid, 0)).toBe(true);
      process.kill(-runner.pid, "SIGINT");
      expect(await exited).toEqual([130, null]);
      await expectReaped(pid);
      pid = undefined;
    } finally {
      if (runner.pid) killIfRunning(-runner.pid);
      if (pid) killIfRunning(pid);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}, 20_000);
