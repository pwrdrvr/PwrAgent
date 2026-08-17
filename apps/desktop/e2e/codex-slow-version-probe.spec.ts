/**
 * A Codex that answers `--version` slowly must still be the Codex we launch.
 *
 * `@pwrdrvr/codex-discovery` probes `--version` with a hard 2s `execFile`
 * timeout on every platform. A probe that blows that budget is not reported
 * as "slow" — the candidate simply comes back with no version, and a version
 * is required for protocol-compatibility gating, so the desktop demotes it.
 * What the operator sees next depends only on what else is installed:
 *
 * - nothing else: Codex reads as missing, and since nothing retries, the app
 *   stays that way until a manual Settings refresh;
 * - something else: selection quietly falls through to it, so an explicitly
 *   configured `[models.codex] path` is replaced by a different Codex.
 *
 * Neither is hypothetical. The invocation is a process chain, and on the
 * Windows lab guest `codex.cmd` answers in ~1.5s warm (`cmd.exe -> node ->
 * shim`) against that 2s ceiling — which is what made
 * `windows-codex-discovery.spec.ts` fail on a cold guest with ZERO app-server
 * launches, at any poll budget.
 *
 * The 3s case here is that failure made deterministic and portable: no slow
 * machine required, and it fails on any platform without the re-probe in
 * `CodexDiscoveryCoordinator.reprobeUnreadVersions`. The 0s case is the guard
 * on the other side — the healthy path must still issue exactly ONE
 * `--version`, which is the coalescing #1720 introduced.
 *
 * If the shared probe budget ever grows past 3s this stops exercising the
 * timeout (it would pass on the first probe) rather than failing falsely;
 * raise the delay here if that happens.
 */
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  FAKE_CODEX_VERSION,
  findFakeCodexRequests,
  readFakeCodexProtocolLog,
  writeFakeCodexExecutable,
} from "./fixtures/fake-agent-executables";

/**
 * Point the app at the fake through `PWRDRVR_CODEX_COMMAND` rather than a
 * seeded `config.toml`.
 *
 * Two reasons, and both matter. It reaches the app process directly, so the
 * spec does not depend on the launched app resolving the same PwrAgent root
 * the harness seeded — `resolvePwragentRoot` falls back to `os.homedir()`,
 * which reads `USERPROFILE` on Windows while the harness overrides `HOME`.
 * And it is the highest-priority source, so this stays a real test on a
 * developer machine that already has a working Codex installed: without the
 * re-probe, a timed-out env command loses to that install.
 */
const CODEX_COMMAND_ENV = "PWRDRVR_CODEX_COMMAND";

/**
 * The slow case spends 2s letting the shared probe time out and 3s answering
 * the re-probe before the app-server can even start, so it needs more than
 * the 30s default to leave the assertions room on a loaded CI guest. That is
 * delay this spec creates on purpose, not slack for an unexplained wait.
 */
test.setTimeout(60_000);

/** Comfortably past the shared 2s `--version` timeout. */
const SLOW_VERSION_PROBE_MS = 3_000;

async function readInvocationArgs(invocationLogPath: string): Promise<string[]> {
  try {
    return (await readFile(invocationLogPath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

for (const versionDelayMs of [0, SLOW_VERSION_PROBE_MS]) {
  test(`configured codex launches with a ${versionDelayMs}ms version probe`, async () => {
    let invocationLogPath = "";
    let protocolLogPath = "";
    const launchEnv: Record<string, string | undefined> = {};
    const app = await launchElectronApp({
      requiresReplayDriver: false,
      env: launchEnv,
      preLaunchHook: async (homeRoot) => {
        const binDir = path.join(homeRoot, "codex-bin");
        await mkdir(binDir, { recursive: true });
        const implPath = path.join(binDir, "codex-impl.js");
        const wrapperPath = path.join(binDir, "codex-probe.js");
        invocationLogPath = path.join(binDir, "invocations.log");
        protocolLogPath = path.join(binDir, "protocol.jsonl");
        await writeFakeCodexExecutable({
          targetPath: implPath,
          protocolLogPath,
          launchMarkerPath: path.join(binDir, "app-server.launched"),
        });
        // Delegates everything except `--version` to the shared fake, so the
        // app-server half of the protocol stays identical to every other spec.
        const wrapperBody = [
          `const fs = require("node:fs");`,
          `try {`,
          `  fs.appendFileSync(${JSON.stringify(invocationLogPath)},`,
          `    Date.now() + " " + process.argv.slice(2).join(" ") + "\\n");`,
          `} catch {}`,
          `if (process.argv.includes("--version")) {`,
          `  setTimeout(() => {`,
          `    process.stdout.write("codex-cli ${FAKE_CODEX_VERSION}\\n");`,
          `    process.exit(0);`,
          `  }, ${versionDelayMs});`,
          `} else {`,
          `  require(${JSON.stringify(implPath)});`,
          `}`,
          "",
        ];

        // Windows cannot run a shebang script, and the shim chain is the whole
        // reason the 2s budget is tight there, so give each platform the shape
        // an operator would actually have: a `.cmd` shim on Windows, a
        // shebang'd executable elsewhere.
        let codexPath: string;
        if (process.platform === "win32") {
          await writeFile(wrapperPath, wrapperBody.join("\n"), "utf8");
          codexPath = path.join(binDir, "codex.cmd");
          await writeFile(
            codexPath,
            [
              "@echo off",
              `"${process.execPath}" "${wrapperPath}" %*`,
              "",
            ].join("\r\n"),
            "utf8",
          );
        } else {
          codexPath = path.join(binDir, "codex");
          await writeFile(
            codexPath,
            ["#!/usr/bin/env node", ...wrapperBody].join("\n"),
            "utf8",
          );
          await chmod(codexPath, 0o755);
        }
        launchEnv[CODEX_COMMAND_ENV] = codexPath;
      },
    });

    try {
      await expect
        .poll(
          async () => {
            const log = await readFakeCodexProtocolLog(protocolLogPath);
            return findFakeCodexRequests(log, "__launch__").length;
          },
          {
            // Covers the deliberate stall: the shared probe's 2s timeout, then
            // the re-probe answering at `versionDelayMs`, then the spawn.
            message:
              "the configured Codex should reach app-server despite a slow --version probe",
            timeout: 25_000,
          },
        )
        .toBe(1);

      // The healthy path must not pay for the recovery path. A second probe
      // here would be the duplicate spawn #1720 removed.
      const versionProbes = (await readInvocationArgs(invocationLogPath))
        .filter((args) => args.includes("--version"));
      expect(versionProbes).toHaveLength(versionDelayMs === 0 ? 1 : 2);
    } finally {
      await app.close();
    }
  });
}
