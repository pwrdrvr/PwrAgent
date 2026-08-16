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
  "This regression exercises native Windows .cmd discovery and launch.",
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
