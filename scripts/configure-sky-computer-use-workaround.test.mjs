import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRAMPOLINE_FILENAME,
  buildMcpAddArgs,
  createSafeCodexCommandError,
  isManagedTrampolineRegistration,
  originalLauncherForApply,
  parseArgs,
  readLauncherBackup,
  readNodeReplRegistration,
  registrationsMatch,
  renderTrampoline,
  resolvePwragentRoot,
} from "./configure-sky-computer-use-workaround.mjs";

describe("configure Sky Computer Use workaround", () => {
  it("defaults to a status check", () => {
    expect(parseArgs([])).toEqual({
      chatgptApp: path.resolve("/Applications/ChatGPT.app"),
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
      chatgptApp: path.resolve("/Volumes/Tools/ChatGPT.app"),
      codexCommand: path.resolve("/opt/codex"),
      mode: "apply",
      pwragentRoot: path.resolve("/tmp/pwragent"),
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

  it("rejects MCP settings that codex mcp add cannot preserve", () => {
    const registration = {
      disabled_reason: null,
      disabled_tools: null,
      enabled: true,
      enabled_tools: null,
      name: "node_repl",
      startup_timeout_sec: null,
      tool_timeout_sec: null,
      transport: {
        args: [],
        command: "/path/to/node_repl",
        cwd: null,
        env: {},
        env_vars: [],
        type: "stdio",
      },
    };
    const unsupported = [
      { enabled: false },
      { enabled_tools: ["js"] },
      { startup_timeout_sec: 30 },
      { unexpected: true },
      { transport: { ...registration.transport, cwd: "/tmp" } },
      { transport: { ...registration.transport, env_vars: ["TOKEN"] } },
    ];

    for (const override of unsupported) {
      expect(() => readNodeReplRegistration({
        ...registration,
        ...override,
      })).toThrow("unsupported settings");
    }
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

  it("redacts environment arguments from Codex command failures", () => {
    const error = Object.assign(
      new Error("codex mcp add --env TOKEN=super-secret node_repl"),
      { code: 1, signal: "SIGTERM" },
    );
    const safeError = createSafeCodexCommandError("mcp add node_repl", error);

    expect(safeError.message).toBe(
      "Codex mcp add node_repl failed (code 1, signal SIGTERM)",
    );
    expect(safeError.message).not.toContain("super-secret");
    expect(safeError.cause).toBeUndefined();
  });

  it("renders the node_repl path as a safe JavaScript string", () => {
    const trampoline = renderTrampoline("/path/with \"quotes\"/node_repl");
    expect(trampoline).toContain(
      'const nodeReplPath = "/path/with \\"quotes\\"/node_repl";',
    );
    expect(trampoline).toContain('stdio: "inherit"');
    expect(trampoline).toContain("process.off(signal, handler)");
  });

  it.skipIf(process.platform === "win32")(
    "propagates a child termination signal",
    async () => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sky-trampoline-test-"));
      const trampolinePath = path.join(tempRoot, TRAMPOLINE_FILENAME);
      try {
        await writeFile(trampolinePath, renderTrampoline(process.execPath));
        const result = await new Promise((resolve, reject) => {
          const trampoline = spawn(process.execPath, [
            trampolinePath,
            "-e",
            'process.kill(process.pid, "SIGTERM")',
          ]);
          trampoline.once("error", reject);
          trampoline.once("exit", (code, signal) => resolve({ code, signal }));
        });
        expect(result).toEqual({ code: null, signal: "SIGTERM" });
      } finally {
        await rm(tempRoot, { recursive: true });
      }
    },
  );

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

  it("retains the real original launcher when moving an installed trampoline", () => {
    const current = {
      args: [path.join("/old-root", "local", TRAMPOLINE_FILENAME)],
      command: path.join(
        "/old-chatgpt",
        "Contents",
        "Resources",
        "cua_node",
        "bin",
        "node",
      ),
      env: { A: "one" },
    };
    const expected = {
      args: [path.join("/new-root", "local", TRAMPOLINE_FILENAME)],
      command: path.join(
        "/new-chatgpt",
        "Contents",
        "Resources",
        "cua_node",
        "bin",
        "node",
      ),
      env: current.env,
    };
    const backup = {
      args: ["--original"],
      command: "/original/node_repl",
    };

    expect(isManagedTrampolineRegistration(current)).toBe(true);
    expect(originalLauncherForApply(current, expected, backup)).toEqual(backup);
    expect(() => originalLauncherForApply(current, expected, undefined))
      .toThrow("has no original-launcher backup");
  });

  it("treats an empty PWRAGENT_HOME as unset", () => {
    const homeDir = path.resolve("/operator-home");
    expect(resolvePwragentRoot(undefined, "   ", homeDir)).toBe(
      path.join(homeDir, ".pwragent"),
    );
  });
});
