import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHookCommand,
  TokenMiserPluginManager,
} from "../token-miser/token-miser-plugin-manager";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { force: true, recursive: true })
    ),
  );
});

describe("TokenMiserPluginManager", () => {
  it("writes an isolated local marketplace plugin with a stable PostToolUse hook", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-plugin-"),
    );
    temporaryDirectories.push(stateDir);
    const manager = new TokenMiserPluginManager({
      stateDir,
      executablePath: "/Applications/Pwr Agent.app/Contents/MacOS/PwrAgent",
      hookEntryPath: "/Applications/Pwr Agent.app/Contents/Resources/app.asar/out/main/token-miser-hook.js",
      platform: "darwin",
    });

    const result = await manager.ensurePluginSource();
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(result.pluginPath, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    const hooks = JSON.parse(
      await fs.readFile(path.join(result.pluginPath, "hooks", "hooks.json"), "utf8"),
    );
    const marketplace = JSON.parse(await fs.readFile(result.marketplacePath, "utf8"));

    expect(manifest).toMatchObject({
      name: "pwragent-token-miser",
      version: "0.1.0",
      license: "MIT",
    });
    expect(manifest).not.toHaveProperty("hooks");
    expect(hooks.hooks.PostToolUse[0].hooks[0]).toMatchObject({
      type: "command",
      timeout: 60,
    });
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain(
      "ELECTRON_RUN_AS_NODE=1",
    );
    expect(marketplace.plugins[0].source.path).toBe(
      "./plugins/pwragent-token-miser",
    );
  });

  it("quotes Windows and POSIX hook commands", () => {
    expect(
      buildHookCommand({
        descriptorPath: "/tmp/profile's bridge.json",
        executablePath: "/Applications/Pwr Agent",
        hookEntryPath: "/tmp/hook.js",
        platform: "darwin",
      }),
    ).toContain("'/tmp/profile'\"'\"'s bridge.json'");
    expect(
      buildHookCommand({
        descriptorPath: "C:\\Pwr Agent\\bridge.json",
        executablePath: "C:\\Pwr Agent\\PwrAgent.exe",
        hookEntryPath: "C:\\Pwr Agent\\hook.js",
        platform: "win32",
      }),
    ).toContain('set "ELECTRON_RUN_AS_NODE=1"');
  });
});
