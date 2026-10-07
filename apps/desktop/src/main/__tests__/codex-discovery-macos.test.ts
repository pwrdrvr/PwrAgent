import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverCodexCommands,
  getCodexInstallCandidatePaths,
} from "@pwrdrvr/codex-discovery";
import { CodexDiscoveryCoordinator } from "../codex-discovery-coordinator";

describe.skipIf(process.platform === "win32")("macOS Codex application discovery", () => {
  let root: string;
  let homeDir: string;
  let coordinator: CodexDiscoveryCoordinator;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "pwragent-codex-macos-"));
    homeDir = path.join(root, "home");
    // Shared discovery also probes the bare command when PATH has no match.
    // An unsupported fixture CLI keeps that probe inside the disposable root.
    await install(path.join(root, "bin", "codex"), "0.1.0");
    coordinator = new CodexDiscoveryCoordinator({
      platform: "darwin",
      resolveEnv: async () => ({ PATH: path.join(root, "bin") }),
      // Exercise the published candidate list and real probes, relocating
      // system paths into the fixture so no host installations are touched.
      discover: (params) => discoverCodexCommands({
        ...params,
        installCandidatePaths: getCodexInstallCandidatePaths("darwin", homeDir)
          .map(fixturePath),
      }),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function fixturePath(command: string): string {
    return command.startsWith(`${root}/`)
      ? command
      : path.join(root, "system", command);
  }

  async function install(command: string, version = "0.160.0"): Promise<string> {
    const fixtureCommand = fixturePath(command);
    await mkdir(path.dirname(fixtureCommand), { recursive: true });
    await writeFile(fixtureCommand, `#!/bin/sh\nprintf '%s\\n' 'codex-cli ${version}'\n`);
    await chmod(fixtureCommand, 0o755);
    return fixtureCommand;
  }

  it.each([
    ["system", "ChatGPT"],
    ["user", "ChatGPT"],
    ["system", "Codex"],
    ["user", "Codex"],
  ])("resolves a %s %s.app install when PATH has no supported CLI", async (scope, app) => {
    const command = await install(path.join(
      scope === "user" ? homeDir : "/",
      "Applications", `${app}.app`, "Contents", "Resources", "codex",
    ));

    await expect(coordinator.resolve()).resolves.toEqual({
      command,
      source: "application",
      version: "0.160.0",
    });
  });

  it("keeps the published macOS candidate order and Homebrew fallbacks", () => {
    expect(getCodexInstallCandidatePaths("darwin", homeDir)).toEqual([
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
      path.join(homeDir, "Applications/ChatGPT.app/Contents/Resources/codex"),
      path.join(homeDir, "Applications/Codex.app/Contents/Resources/codex"),
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });

  it("selects the newest version across ChatGPT.app and Codex.app", async () => {
    await install("/Applications/ChatGPT.app/Contents/Resources/codex", "0.160.0");
    const command = await install("/Applications/Codex.app/Contents/Resources/codex", "0.161.0");

    await expect(coordinator.resolve()).resolves.toMatchObject({ command, version: "0.161.0" });
  });

  it("keeps an explicitly configured Codex.app ahead of a newer ChatGPT.app", async () => {
    await install("/Applications/ChatGPT.app/Contents/Resources/codex", "0.161.0");
    const command = await install("/Applications/Codex.app/Contents/Resources/codex", "0.160.0");

    await expect(coordinator.resolve(command)).resolves.toEqual({
      command,
      source: "config",
      version: "0.160.0",
    });
  });
});
