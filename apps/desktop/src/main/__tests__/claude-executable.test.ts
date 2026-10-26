import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeEnvironment, inspectClaudeInstallation as inspectInstallation, resolveClaudeExecutable, selectClaudeExecutable, claudeLoginCommand, CLAUDE_SIGN_IN_REQUIRED } from "../claude/claude-executable";

const inspectClaudeInstallation = (options: Parameters<typeof inspectInstallation>[0]) => inspectInstallation({
  resolveBundledExecutable: async () => undefined,
  readVersion: async () => "2.1.296 (Claude Code)",
  ...options,
});
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

  it.each([
    [{ authMethod: "api_key", apiProvider: "firstParty" }, "api-key"],
    [{ authMethod: "claude.ai", subscriptionType: "max" }, "claude-account"],
    [{ apiProvider: "bedrock" }, "external"],
    [{ authMethod: "unexpected-private-value" }, undefined],
  ] as const)("reports only known CLI authentication categories (%j)", async (status, authMethod) => {
    const installation = await inspectClaudeInstallation({
      resolveExecutable: async () => "/fixture/claude",
      readAuthStatus: async () => JSON.stringify({
        loggedIn: true, ...status, apiKey: "secret-key", accessToken: "secret-token", email: "private-email",
      }),
    });
    expect(installation).toMatchObject({ authStatus: "signed-in" });
    expect(installation.authMethod).toBe(authMethod);
    expect(JSON.stringify(installation)).not.toMatch(/secret-key|secret-token|private-email|unexpected-private-value/);
  });

  it("does not pass application credentials to the CLI", () => {
    const input = { PATH: "/bin", ANTHROPIC_API_KEY: "key", CLAUDE_CODE_OAUTH_TOKEN: "token" };
    expect(claudeEnvironment(input)).toEqual({ PATH: "/bin", CLAUDE_CODE_REPORT_FINDINGS: "1", CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });
    expect(input.ANTHROPIC_API_KEY).toBe("key");
  });

  it("declares that PwrAgent renders typed code-review findings", () => {
    // Without the declaration, /code-review forks and returns plain text.
    expect(claudeEnvironment({ PATH: "/bin" }).CLAUDE_CODE_REPORT_FINDINGS).toBe("1");
  });
});


describe("Claude binary selection", () => {
  it.each([
    [undefined, "2.1.296", "bundled"],
    ["2.1.295", "2.1.296", "bundled"],
    ["2.1.9", "2.1.296", "bundled"],
    ["2.1.296", "2.1.296", "system"],
    ["2.1.300", "2.1.296", "system"],
    ["2.2.0", "2.1.296", "system"],
    ["2.1.296", undefined, "system"],
  ])("selects %s vs bundled %s as %s", async (systemVersion, bundledVersion, source) => {
    const result = await selectClaudeExecutable({
      system: systemVersion ? "/system/claude" : undefined,
      bundled: bundledVersion ? "/bundled/claude" : undefined,
      readVersion: async (file) => `${file.includes("system") ? systemVersion : bundledVersion} (Claude Code)`,
    });
    expect(result).toMatchObject({ source, executable: `/${source}/claude` });
  });

  it("uses the bundled binary when the system version probe fails", async () => {
    expect(await selectClaudeExecutable({ system: "/system", bundled: "/bundled",
      readVersion: async (file) => { if (file === "/system") throw new Error("cannot launch"); return "2.1.296 (Claude Code)"; },
    })).toMatchObject({ executable: "/bundled", source: "bundled" });
  });

  it("does not select an unusable bundled executable", async () => {
    expect(await selectClaudeExecutable({ bundled: "/bundled", readVersion: async () => "garbage" })).toEqual({});
  });

  it("checks auth on the selected bundled binary and supplies its own login command", async () => {
    const readAuthStatus = vi.fn().mockResolvedValue('{"loggedIn":false}');
    const installation = await inspectClaudeInstallation({
      resolveExecutable: async () => undefined,
      resolveBundledExecutable: async () => "/Applications/PwrAgent App/claude",
      readAuthStatus,
    });
    expect(installation).toMatchObject({ source: "bundled", version: "2.1.296", authStatus: "sign-in-required" });
    expect(readAuthStatus.mock.calls[0][0]).toBe("/Applications/PwrAgent App/claude");
    expect(installation.loginCommand).toContain("/Applications/PwrAgent App/claude");
    expect(installation.loginCommand).toContain("auth login");
    // The command, with its bundle path, stays out of the message.
    expect(installation.message).toBe(CLAUDE_SIGN_IN_REQUIRED);
  });

  it("quotes the bundled login path for POSIX shells and Windows PowerShell", () => {
    expect(claudeLoginCommand("/app/Claude's binary", "darwin")).toBe("'/app/Claude'\"'\"'s binary' auth login");
    expect(claudeLoginCommand("C:\\Program Files\\Claude's binary.exe", "win32"))
      .toBe("& 'C:\\Program Files\\Claude''s binary.exe' auth login");
  });
});
