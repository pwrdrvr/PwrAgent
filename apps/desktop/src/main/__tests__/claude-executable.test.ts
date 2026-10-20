import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeEnvironment, inspectClaudeInstallation, resolveClaudeExecutable } from "../claude/claude-executable";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("Claude executable discovery", () => {
  it.skipIf(process.platform === "win32")("resolves the user's executable symlink without launching it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pwragent-claude-cli-"));
    roots.push(root);
    await mkdir(path.join(root, "bin"));
    const binary = path.join(root, "official-cli");
    await writeFile(binary, "#!/bin/sh\nexit 0\n");
    await chmod(binary, 0o755);
    await symlink(binary, path.join(root, "bin", "claude"));
    await expect(resolveClaudeExecutable({ env: { PATH: path.join(root, "bin") }, homeDir: root }))
      .resolves.toBe(await realpath(binary));
  });

  it("finds the native Windows install after ignoring shell shims", async () => {
    const executable = "C:\\Users\\fixture\\.local\\bin\\claude.exe";
    const probe = vi.fn(async (candidate: string) => candidate === executable ? executable : undefined);
    await expect(resolveClaudeExecutable({
      platform: "win32", homeDir: "C:\\Users\\fixture", env: { Path: "C:\\npm" }, resolveCandidate: probe,
    })).resolves.toBe(executable);
    expect(probe.mock.calls.every(([candidate]) => !/\.(cmd|bat|ps1)$/i.test(candidate))).toBe(true);
  });

  it("resolves the official npm entry on Windows without executing a shim", async () => {
    const executable = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
    await expect(resolveClaudeExecutable({
      platform: "win32", homeDir: "C:\\fixture", env: { PATH: "C:\\npm" },
      resolveCandidate: async (candidate) => candidate === executable ? executable : undefined,
    })).resolves.toBe(executable);
  });

  it("rejects candidates whose resolved target is a shell shim", async () => {
    await expect(resolveClaudeExecutable({
      platform: "win32", homeDir: "C:\\fixture", env: { PATH: "C:\\npm" },
      resolveCandidate: async () => "C:\\npm\\claude.cmd",
    })).resolves.toBeUndefined();
  });

  it("shows setup instructions without probing auth when no executable exists", async () => {
    const readAuthStatus = vi.fn();
    const installation = await inspectClaudeInstallation({ resolveExecutable: async () => undefined, readAuthStatus });
    expect(installation.message).toContain("claude auth login");
    expect(installation.executable).toBeUndefined();
    expect(readAuthStatus).not.toHaveBeenCalled();
  });

  it.each([[true, "signed-in"], [false, "sign-in-required"]])("reports CLI loggedIn=%s without retaining credentials", async (loggedIn, authStatus) => {
    const installation = await inspectClaudeInstallation({
      resolveExecutable: async () => "/fixture/claude",
      readAuthStatus: async () => JSON.stringify({ loggedIn, apiKey: "never-store", email: "private" }),
    });
    expect(installation.authStatus).toBe(authStatus);
    expect(JSON.stringify(installation)).not.toMatch(/never-store|private/);
  });

  it("does not claim sign-in after a failed or malformed status probe", async () => {
    for (const readAuthStatus of [async () => "garbage", async () => { throw new Error("timeout"); }]) {
      const installation = await inspectClaudeInstallation({ resolveExecutable: async () => "/fixture/claude", readAuthStatus });
      expect(installation.authStatus).toBe("unknown");
    }
  });

  it("does not pass application credentials to the CLI", () => {
    const input = { PATH: "/bin", ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token" };
    expect(claudeEnvironment(input)).toEqual({ PATH: "/bin" });
    expect(input.ANTHROPIC_API_KEY).toBe("key");
  });
});
