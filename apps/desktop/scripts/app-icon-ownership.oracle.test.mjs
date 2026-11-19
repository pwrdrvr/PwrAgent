import { execFile } from "node:child_process";
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
      vitest, ...expected.args, "--config", config, "apps/desktop/scripts/app-icon.test.mjs",
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
    await writeFile(join(fixture, "actool"), '#!/bin/sh\nprintf "%s\\n" "$$" > "$ACTOOL_ORACLE_PID"\nexec /bin/sleep 60\n', { mode: 0o755 });
    vi.stubEnv("PATH", [fixture, process.env.PATH].join(delimiter));
    vi.stubEnv("ACTOOL_ORACLE_PID", pidFile);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const compiled = compileAppIcon(join(root, "apps/desktop/build/icon.icon"), outputDir, 100);
    const settled = compiled.catch(() => {});
    const signal = AbortSignal.timeout(10_000);
    let pid;
    try {
      while (!pid) {
        const contents = await readFile(pidFile, "utf8").catch((error) => {
          if (error.code !== "ENOENT") throw error;
          return "";
        });
        pid = Number.parseInt(contents, 10);
        if (!pid) await delay(20, undefined, { signal });
      }
      expect(process.kill(pid, 0)).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      await expect(compiled).rejects.toThrow("actool icon compilation timed out after 100 ms");
      vi.useRealTimers();
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(
        expect.objectContaining({ code: "ESRCH" }),
      ));
      pid = undefined;
    } finally {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(100);
      await settled;
      if (pid) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(fixture, { recursive: true, force: true });
  }
}, 15_000);
