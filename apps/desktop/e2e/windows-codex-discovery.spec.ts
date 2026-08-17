import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { launchElectronApp } from "./fixtures/electron-app";
import {
  findFakeCodexRequests,
  readFakeCodexProtocolLog,
  writeFakeCodexExecutable,
} from "./fixtures/fake-agent-executables";

test.skip(
  process.platform !== "win32",
  "This regression exercises native Windows shim discovery and launch.",
);

function envKey(name: string): string {
  return Object.keys(process.env).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  ) ?? name;
}

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

function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

test("PATH discovery launches one version probe and starts a real thread", async () => {
  let invocationLogPath = "";
  let protocolLogPath = "";
  const pathKey = envKey("PATH");
  const pathExtKey = envKey("PATHEXT");
  const launchEnv: Record<string, string | undefined> = {
    PWRAGENT_CODEX_COMMAND: undefined,
  };
  const app = await launchElectronApp({
    requiresReplayDriver: false,
    env: launchEnv,
    preLaunchHook: async (homeRoot) => {
      const binDir = path.join(homeRoot, "codex-bin");
      const scriptPath = path.join(binDir, "codex.js");
      const commandPath = path.join(binDir, "codex.cmd");
      invocationLogPath = path.join(binDir, "invocations.log");
      protocolLogPath = path.join(binDir, "protocol.jsonl");
      const launchMarkerPath = path.join(binDir, "app-server.launched");
      await writeFakeCodexExecutable({
        targetPath: scriptPath,
        protocolLogPath,
        launchMarkerPath,
      });
      await writeFile(
        commandPath,
        [
          "@echo off",
          `echo %*>>"${invocationLogPath}"`,
          `"${process.execPath}" "${scriptPath}" %*`,
          "",
        ].join("\r\n"),
        "utf8",
      );

      const inheritedPath = process.env[pathKey] ?? "";
      launchEnv[pathKey] = `${binDir};${inheritedPath}`;
      launchEnv[pathExtKey] = ".COM;.EXE;.BAT;.CMD";
    },
  });

  try {
    await expect.poll(async () => {
      const log = await readFakeCodexProtocolLog(protocolLogPath);
      return findFakeCodexRequests(log, "__launch__").length;
    }).toBe(1);

    await app.window.getByRole("button", { name: "New thread" }).click();
    const prompt = app.window.getByRole("textbox", { name: "New thread" });
    await prompt.fill("Windows Codex discovery works");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect.poll(async () => {
      const log = await readFakeCodexProtocolLog(protocolLogPath);
      return findFakeCodexRequests(log, "thread/start").length;
    }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => {
      const invocations = await readInvocationArgs(invocationLogPath);
      return {
        appServer: invocations.filter((args) => args.includes("app-server")).length,
        version: invocations.filter((args) => args.includes("--version")).length,
      };
    }).toEqual({ appServer: 1, version: 1 });
  } finally {
    await app.close();
  }
});

/**
 * npm installs three shims side by side: `codex` (sh), `codex.cmd`, and
 * `codex.ps1`. The shared PATH scan walks `[name, ...PATHEXT]` in that order,
 * so it stops on the extensionless sh shim — unusable on Windows — and never
 * reaches codex.cmd. That is why a working nvm-windows install reported
 * "Missing", and why the .ps1 was tempting as a substitute: it version-probes
 * fine (stdin closed) but cannot host the app-server (stdin held open sends
 * npm's shim down its `$input | & node …` branch, and `initialize` never
 * returns).
 *
 * This is that exact directory layout. Discovery must land on codex.cmd and
 * the .ps1 must never be invoked.
 */
test("npm shim trio discovers and launches through codex.cmd", async () => {
  let invocationLogPath = "";
  let powerShellLogPath = "";
  let protocolLogPath = "";
  const pathKey = envKey("PATH");
  const pathExtKey = envKey("PATHEXT");
  const launchEnv: Record<string, string | undefined> = {
    PWRAGENT_CODEX_COMMAND: undefined,
  };
  const app = await launchElectronApp({
    requiresReplayDriver: false,
    env: launchEnv,
    preLaunchHook: async (homeRoot) => {
      const binDir = path.join(homeRoot, "codex-shim-trio-bin");
      const scriptPath = path.join(binDir, "codex.js");
      invocationLogPath = path.join(binDir, "invocations.log");
      powerShellLogPath = path.join(binDir, "powershell-invocations.log");
      protocolLogPath = path.join(binDir, "protocol.jsonl");
      const launchMarkerPath = path.join(binDir, "app-server.launched");
      await writeFakeCodexExecutable({
        targetPath: scriptPath,
        protocolLogPath,
        launchMarkerPath,
      });

      // The sh shim npm writes for Git Bash. Windows cannot run it, and it is
      // what the shared PATH scan finds first.
      await writeFile(
        path.join(binDir, "codex"),
        ['#!/bin/sh', 'echo "sh shim is not usable on Windows" >&2', "exit 1", ""].join("\n"),
        "utf8",
      );
      await writeFile(
        path.join(binDir, "codex.cmd"),
        [
          "@echo off",
          `echo %*>>"${invocationLogPath}"`,
          `"${process.execPath}" "${scriptPath}" %*`,
          "",
        ].join("\r\n"),
        "utf8",
      );
      await writeFile(
        path.join(binDir, "codex.ps1"),
        [
          `Add-Content -LiteralPath ${powerShellLiteral(powerShellLogPath)} -Value ($args -join ' ')`,
          `& ${powerShellLiteral(process.execPath)} ${powerShellLiteral(scriptPath)} @args`,
          "exit $LASTEXITCODE",
          "",
        ].join("\r\n"),
        "utf8",
      );

      const inheritedPath = process.env[pathKey] ?? "";
      launchEnv[pathKey] = `${binDir};${inheritedPath}`;
      launchEnv[pathExtKey] = ".COM;.EXE;.BAT;.CMD";
    },
  });

  try {
    await expect.poll(async () => {
      const log = await readFakeCodexProtocolLog(protocolLogPath);
      return findFakeCodexRequests(log, "__launch__").length;
    }).toBe(1);

    await app.window.getByRole("button", { name: "New thread" }).click();
    const prompt = app.window.getByRole("textbox", { name: "New thread" });
    await prompt.fill("Windows npm shim discovery works");
    await app.window.getByRole("button", { name: "Start thread" }).click();

    await expect.poll(async () => {
      const log = await readFakeCodexProtocolLog(protocolLogPath);
      return findFakeCodexRequests(log, "thread/start").length;
    }).toBeGreaterThanOrEqual(1);
    await expect.poll(async () => {
      const invocations = await readInvocationArgs(invocationLogPath);
      return {
        appServer: invocations.filter((args) => args.includes("app-server")).length,
        version: invocations.filter((args) => args.includes("--version")).length,
      };
    }).toEqual({ appServer: 1, version: 1 });

    expect(await readInvocationArgs(powerShellLogPath)).toEqual([]);
  } finally {
    await app.close();
  }
});
