import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("serializes concurrent plugin source refreshes for Windows-safe replacement", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-source-race-"),
    );
    temporaryDirectories.push(stateDir);
    const realRename = fs.rename.bind(fs);
    const activeTargets = new Set<string>();
    vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      const target = String(newPath);
      if (activeTargets.has(target)) {
        throw Object.assign(new Error("concurrent Windows replacement"), {
          code: "EPERM",
        });
      }
      activeTargets.add(target);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        await realRename(oldPath, newPath);
      } finally {
        activeTargets.delete(target);
      }
    });
    const manager = new TokenMiserPluginManager({
      stateDir,
      profileName: "dev",
      executablePath: "C:\\PwrAgent\\PwrAgent.exe",
      hookEntryPath: "C:\\PwrAgent\\token-miser-hook.js",
      platform: "win32",
    });

    const [first, second] = await Promise.all([
      manager.ensurePluginSource(),
      manager.ensurePluginSource(),
    ]);

    expect(second).toEqual(first);
    expect(activeTargets.size).toBe(0);
  });

  it("writes an isolated local marketplace plugin with a stable PostToolUse hook", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-plugin-"),
    );
    temporaryDirectories.push(stateDir);
    const manager = new TokenMiserPluginManager({
      stateDir,
      profileName: "default",
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
    expect(hooks.hooks.PostToolUse[0].hooks[0].command).toContain(
      '"$PWRAGENT_TOKEN_MISER_BRIDGE_DESCRIPTOR_PATH"',
    );
    expect(marketplace.name).toBe("pwragent-local-default");
    expect(marketplace.plugins[0].source.path).toBe(
      "./plugins/pwragent-token-miser",
    );
  });

  it("quotes Windows and POSIX hook commands", () => {
    expect(
      buildHookCommand({
        executablePath: "/Applications/Pwr Agent",
        hookEntryPath: "/tmp/hook.js",
        platform: "darwin",
      }),
    ).toBe(
      "ELECTRON_RUN_AS_NODE=1 '/Applications/Pwr Agent' '/tmp/hook.js' "
      + '"$PWRAGENT_TOKEN_MISER_BRIDGE_DESCRIPTOR_PATH"',
    );
    expect(
      buildHookCommand({
        executablePath: "C:\\Pwr Agent\\PwrAgent.exe",
        hookEntryPath: "C:\\Pwr Agent\\hook.js",
        platform: "win32",
      }),
    ).toBe(
      'set "ELECTRON_RUN_AS_NODE=1" && "C:\\Pwr Agent\\PwrAgent.exe"'
      + ' "C:\\Pwr Agent\\hook.js"'
      + ' "%PWRAGENT_TOKEN_MISER_BRIDGE_DESCRIPTOR_PATH%"',
    );
  });

  it("registers and installs the plugin in the active Codex profile once", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "pwragent-token-miser-install-"),
    );
    temporaryDirectories.push(stateDir);
    const runCodexCommand = vi.fn(async () => undefined);
    const manager = new TokenMiserPluginManager({
      stateDir,
      profileName: "dev",
      executablePath: "/Applications/PwrAgent.app/Contents/MacOS/PwrAgent",
      hookEntryPath: "/Applications/PwrAgent.app/Contents/Resources/token-miser-hook.js",
      platform: "darwin",
      runCodexCommand,
    });
    const codexEnv = {
      CODEX_HOME: "/Users/operator/.codex/profiles/dev",
      PATH: "/usr/bin",
    };

    await Promise.all([
      manager.ensureInstalled({ codexCommand: "/usr/bin/codex", codexEnv }),
      manager.ensureInstalled({ codexCommand: "/usr/bin/codex", codexEnv }),
    ]);
    await manager.ensureInstalled({ codexCommand: "/usr/bin/codex", codexEnv });

    expect(runCodexCommand).toHaveBeenCalledTimes(3);
    // Retire this profile's own pre-scoping entry before claiming the scoped
    // one, so the shared name stops blocking every other profile.
    expect(runCodexCommand).toHaveBeenNthCalledWith(1, {
      command: "/usr/bin/codex",
      args: ["plugin", "marketplace", "remove", "pwragent-local", "--json"],
      env: codexEnv,
      tolerateFailure: true,
    });
    expect(runCodexCommand).toHaveBeenNthCalledWith(2, {
      command: "/usr/bin/codex",
      args: [
        "plugin",
        "marketplace",
        "add",
        path.join(stateDir, "marketplace"),
        "--json",
      ],
      env: codexEnv,
    });
    // Scoped by profile: Codex keys marketplaces by name, so an unscoped name
    // let the first profile to activate lock out every other one.
    expect(runCodexCommand).toHaveBeenNthCalledWith(3, {
      command: "/usr/bin/codex",
      args: [
        "plugin",
        "add",
        "pwragent-token-miser@pwragent-local-dev",
        "--json",
      ],
      env: codexEnv,
    });
  });
});
