import { describe, expect, it } from "vitest";
import {
  buildMcpAddArgs,
  parseArgs,
  readLauncherBackup,
  readNodeReplRegistration,
  registrationsMatch,
  renderTrampoline,
} from "./configure-sky-computer-use-workaround.mjs";

describe("configure Sky Computer Use workaround", () => {
  it("defaults to a status check", () => {
    expect(parseArgs([])).toEqual({
      chatgptApp: "/Applications/ChatGPT.app",
      codexCommand: undefined,
      mode: "status",
      pwragentRoot: undefined,
    });
  });

  it("accepts pnpm's argument separator", () => {
    expect(parseArgs(["--", "--status"]).mode).toBe("status");
  });

  it("accepts one mutation mode and path overrides", () => {
    expect(parseArgs([
      "--apply",
      "--chatgpt-app",
      "/Volumes/Tools/ChatGPT.app",
      "--codex",
      "/opt/codex",
      "--pwragent-root",
      "/tmp/pwragent",
    ])).toEqual({
      chatgptApp: "/Volumes/Tools/ChatGPT.app",
      codexCommand: "/opt/codex",
      mode: "apply",
      pwragentRoot: "/tmp/pwragent",
    });
  });

  it("rejects ambiguous modes", () => {
    expect(() => parseArgs(["--apply", "--restore"]))
      .toThrow("Select exactly one");
  });

  it("reads a stdio registration without exposing Codex storage", () => {
    expect(readNodeReplRegistration({
      transport: {
        args: ["--example"],
        command: "/path/to/node_repl",
        env: { A: "one", B: "two" },
        type: "stdio",
      },
    })).toEqual({
      args: ["--example"],
      command: "/path/to/node_repl",
      env: { A: "one", B: "two" },
    });
  });

  it("validates the launcher backup without persisting environment values", () => {
    expect(readLauncherBackup({
      args: ["--example"],
      command: "/original/node_repl",
      version: 1,
    })).toEqual({
      args: ["--example"],
      command: "/original/node_repl",
    });
    expect(() => readLauncherBackup({
      args: [],
      command: "/original/node_repl",
      version: 2,
    })).toThrow("Unsupported");
  });

  it("preserves every environment value in the replacement command", () => {
    expect(buildMcpAddArgs(
      {
        args: [],
        command: "/old/node_repl",
        env: {
          NODE_REPL_TRUSTED_SERVICES: "{\"sky\":\"@oai/sky/service\"}",
          SKY_CUA_SERVICE_PATH: "/path with spaces/Codex Computer Use.app",
        },
      },
      "/signed/node",
      ["/path/to/trampoline.cjs"],
    )).toEqual([
      "mcp",
      "add",
      "--env",
      "NODE_REPL_TRUSTED_SERVICES={\"sky\":\"@oai/sky/service\"}",
      "--env",
      "SKY_CUA_SERVICE_PATH=/path with spaces/Codex Computer Use.app",
      "node_repl",
      "--",
      "/signed/node",
      "/path/to/trampoline.cjs",
    ]);
  });

  it("renders the node_repl path as a safe JavaScript string", () => {
    const trampoline = renderTrampoline("/path/with \"quotes\"/node_repl");
    expect(trampoline).toContain(
      'const nodeReplPath = "/path/with \\"quotes\\"/node_repl";',
    );
    expect(trampoline).toContain('stdio: "inherit"');
  });

  it("compares the complete command, args, and environment", () => {
    const registration = {
      args: ["/trampoline.cjs"],
      command: "/signed/node",
      env: { A: "one", B: "two" },
    };
    expect(registrationsMatch(registration, registration)).toBe(true);
    expect(registrationsMatch(registration, {
      ...registration,
      env: { B: "two", A: "one" },
    })).toBe(true);
    expect(registrationsMatch(registration, {
      ...registration,
      env: { A: "two" },
    })).toBe(false);
  });
});
