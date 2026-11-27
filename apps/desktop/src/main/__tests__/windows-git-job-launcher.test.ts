import * as childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runGitCommand } from "../app-server/git-executable";
import { PR_METADATA_PRIORITY, runPrMetadataGit } from "../pr-status/pr-metadata-process";
import { readWindowsJobStartupTelemetry, windowsJobCleanupVerified, wrapCommandInWindowsJob } from "../windows-job-wrapper";
import { isolateProcessGitEnvironment } from "./helpers/isolated-git";

const fixture = vi.hoisted(() => ({ launcher: "" }));
vi.mock("../windows-job-launcher-path", () => ({ windowsJobLauncherPath: () => fixture.launcher }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

describe.skipIf(process.platform !== "win32")("compiled Windows stack Git launcher", () => {
  let sandbox: string;
  let git: string;
  let gitEnv: NodeJS.ProcessEnv;
  let root: string;

  function runFixtureGit(...args: string[]): string {
    return childProcess.execFileSync(git, ["-C", root, ...args], { env: gitEnv, encoding: "utf8", windowsHide: true });
  }

  beforeAll(async () => {
    sandbox = await mkdtemp(path.join(os.tmpdir(), "pwragent Windows Git job "));
    const build = fileURLToPath(new URL("../../../scripts/build-windows-job-launcher.mjs", import.meta.url));
    childProcess.execFileSync(process.execPath, [build, sandbox], { windowsHide: true });
    fixture.launcher = path.join(sandbox, "pwragent-windows-job.exe");
    expect(existsSync(fixture.launcher)).toBe(true);
    git = childProcess.execFileSync("where.exe", ["git.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)[0]!;
    // A signing-enabled global config would break the fixture's first commit.
    const operatorConfig = path.join(sandbox, "operator-gitconfig");
    const missingSigner = JSON.stringify(path.join(sandbox, "missing-fixture-signer.exe"));
    await writeFile(operatorConfig, `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = ${missingSigner}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", operatorConfig);
    const restoreGitEnv = isolateProcessGitEnvironment(sandbox);
    try {
      gitEnv = { ...process.env };
    } finally {
      restoreGitEnv();
      vi.unstubAllEnvs();
    }
    root = path.join(sandbox, "fixture clone");
    childProcess.execFileSync(git, ["init", "-b", "main", root], { cwd: sandbox, env: gitEnv, windowsHide: true });
    runFixtureGit("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
    await writeFile(path.join(sandbox, "hold-checkout.cjs"), `
      require('node:fs').writeFileSync(process.env.FIXTURE_PID, String(process.pid));
      setTimeout(() => process.exit(98), 20_000);
    `);
    await writeFile(path.join(sandbox, "git-handoff.cjs"), `
      const child = require('node:child_process').spawn(process.execPath, [require.resolve('./hold-checkout.cjs')], {
        // Skip the driver's own libuv Job so its exit leaves the worker in the PwrAgent Job.
        cwd: process.env.FIXTURE_WORKTREE, detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.once('spawn', () => child.unref());
    `);
  }, 30_000);

  afterAll(async () => {
    if (sandbox) await rm(sandbox, { force: true, recursive: true, maxRetries: 2 });
  });

  it("matches direct Git for each stack command and honors the selected executable and Git environment", async () => {
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    try {
      const env = {
        ...gitEnv, PWRAGENT_GIT_PATH: git, GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "fixture.marker", GIT_CONFIG_VALUE_0: 'a quote " and a backslash \\',
      };
      const commands = [
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
        ["worktree", "list", "--porcelain", "-z"],
        ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(upstream)", "refs/heads/", "refs/remotes/"],
        ["config", "--get", "fixture.marker"],
        ["-c", 'fixture.argv=  ü "quoted" \\', "config", "--get", "fixture.argv"],
      ];
      for (const args of commands) {
        const expected = childProcess.execFileSync(git, ["-C", root, ...args], { env, encoding: "utf8" });
        const result = await runGitCommand(root, args, { env, ownProcessTree: true, purpose: "stack-status" });
        expect(result.stdout).toBe(expected);
      }
      expect(spawn.mock.calls.map(([command]) => command)).toEqual(commands.map(() => fixture.launcher));
    } finally {
      spawn.mockClear();
    }
  }, 30_000);

  it("confirms cleanup without executing a Git target when stopped before startup", async () => {
    const wrapper = wrapCommandInWindowsJob({
      command: process.execPath,
      args: ["-e", "process.exit(42)"],
      env: process.env,
      cwd: sandbox,
      compiledLauncher: fixture.launcher,
      keepDrainEvidenceOnStop: true,
    });
    try {
      wrapper.requestStop!();
      const child = childProcess.spawn(wrapper.command, wrapper.args, { env: wrapper.env, windowsHide: true, stdio: "ignore" });
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code).toBe(1);
      expect(existsSync(wrapper.readyFilePath)).toBe(false);
      const phases = readWindowsJobStartupTelemetry(wrapper).phases.map(({ phase }) => phase);
      expect(phases).toContain("target-assigned");
      expect(phases).not.toContain("target-resumed");
      expect(windowsJobCleanupVerified(wrapper)).toBe(true);
    } finally {
      wrapper.cleanup();
    }
  }, 30_000);

  it.each(["abort", "timeout"])("drains a launcher handoff before a worktree can be removed after %s", async (stop) => {
    const checkout = path.join(sandbox, `checkout ${stop}`);
    const pidFile = path.join(sandbox, `${stop}.pid`);
    runFixtureGit("worktree", "add", "--detach", checkout);
    const controller = new AbortController();
    const spawn = vi.mocked(childProcess.spawn);
    spawn.mockClear();
    const read = runPrMetadataGit(checkout, [path.join(sandbox, "git-handoff.cjs")], {
      timeout: stop === "timeout" ? 5_000 : 30_000,
      env: { ...gitEnv, PWRAGENT_GIT_PATH: process.execPath, FIXTURE_WORKTREE: checkout, FIXTURE_PID: pidFile },
      ownProcessTree: true, signal: controller.signal, purpose: "stack-checkout",
    }, { signal: controller.signal, priority: () => PR_METADATA_PRIORITY.selected });
    void read.catch(() => undefined);
    try {
      const pid = await Promise.race([
        vi.waitFor(async () => {
          const recorded = Number(await readFile(pidFile, "utf8"));
          expect(recorded).toBeGreaterThan(0);
          return recorded;
        }, { timeout: 10_000 }),
        read.then(({ stderr }) => { throw new Error(`The fixture exited before its descendant acquired the checkout: ${stderr}`); }),
      ]);
      const launch = spawn.mock.calls.find(([command]) => command === fixture.launcher);
      const startupStatusFilePath = (launch?.[2] as childProcess.SpawnOptions | undefined)?.env?.PWRAGENT_JOB_WRAPPER_STARTUP_STATUS_FILE;
      expect(startupStatusFilePath).toBeTruthy();
      await vi.waitFor(() => {
        const phases = readWindowsJobStartupTelemetry({ startupStatusFilePath: startupStatusFilePath! }).phases;
        expect(phases.map(({ phase }) => phase)).toContain("target-exited");
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      if (stop === "abort") {
        controller.abort();
        await expect(read).rejects.toMatchObject({ name: "AbortError" });
      } else {
        await expect(read).rejects.toMatchObject({ killed: true, signal: "SIGTERM" });
      }
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      runFixtureGit("worktree", "remove", checkout);
      expect(existsSync(checkout)).toBe(false);
    } finally {
      controller.abort();
      await read.catch(() => undefined);
      spawn.mockClear();
    }
  }, 30_000);
});
