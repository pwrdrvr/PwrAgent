import { codexAuthState } from "../codex-auth-state";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { compareCodexCliVersions } from "@pwrdrvr/codex-discovery";
import { StdioJsonRpcTransport } from "../codex-app-server/stdio-transport";

const { resolveCodexCommandMock, spawnMock, transportLog } = vi.hoisted(() => ({
  resolveCodexCommandMock: vi.fn(async ({ command }: { command: string }) => ({
    command,
    source: "path",
    version: "0.126.0",
  })),
  spawnMock: vi.fn(),
  transportLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => transportLog),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("@pwrdrvr/codex-discovery", async () => {
  const actual = await vi.importActual<typeof import("@pwrdrvr/codex-discovery")>(
    "@pwrdrvr/codex-discovery",
  );
  return {
    ...actual,
    resolveCodexCommand: resolveCodexCommandMock,
  };
});

class MockCodexChildProcess extends EventEmitter {
  readonly writes: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString());
      callback();
    },
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killCalled = false;

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.killCalled = true;
    this.signalCode = signal;
    this.emit("close");
    return true;
  }
}

function createBundledToolsDirectory(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "pwragent-bundled-tools-"));
  const executable = path.join(
    directory,
    process.platform === "win32" ? "rg.exe" : "rg",
  );
  writeFileSync(executable, "#!/bin/sh\nexit 0\n");
  if (process.platform !== "win32") {
    chmodSync(executable, 0o755);
  }
  return directory;
}

beforeEach(() => {
  resolveCodexCommandMock.mockClear();
  spawnMock.mockReset();
  transportLog.info.mockClear();
  transportLog.warn.mockClear();
  transportLog.error.mockClear();
});

describe("stdio transport Codex CLI resolution", () => {
  it("orders stable Codex CLI releases ahead of prereleases with the same version", () => {
    expect(compareCodexCliVersions("0.125.0", "0.125.0-alpha.3")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.125.0-alpha.4", "0.125.0-alpha.3")).toBeGreaterThan(0);
  });

  it("orders newer Codex.app prereleases ahead of older stable PATH releases", () => {
    expect(compareCodexCliVersions("0.126.0-alpha.1", "0.125.0")).toBeGreaterThan(0);
  });
});

describe("StdioJsonRpcTransport", () => {
  it.each([
    ["ERROR", "error"],
    ["WARN", "warn"],
    ["INFO", "info"],
  ] as const)("logs colored %s diagnostics at %s without terminal escapes", async (severity, level) => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const exited = vi.fn();
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: "/fixture/stderr-codex" },
      onUnexpectedExit: exited,
    });
    await transport.connect();
    const message = "worker quit with fatal: Transport channel closed, when UnexpectedServerResponse(\"HTTP 401: Unauthorized\")";
    child.stderr.write(`\u001b[2m2026-10-02T22:04:11.467490Z\u001b[0m \u001b[31m${severity}\u001b[0m \u001b[2mrmcp::transport::worker\u001b[0m\u001b[2m:\u001b[0m ${message}\n`);
    const line = `2026-10-02T22:04:11.467490Z ${severity} rmcp::transport::worker: ${message}`;
    expect(transportLog[level]).toHaveBeenCalledWith("app-server stderr", { line });
    if (level !== "info") {
      expect(transportLog.info).not.toHaveBeenCalledWith("app-server stderr", expect.anything());
    }
    expect(codexAuthState.isBlocked("/fixture/stderr-codex")).toBe(false);
    child.emit("close", 1, null);
    expect(exited).toHaveBeenCalledWith({ code: 1, signal: null, stderrPreview: [line] });
    await transport.close();
  });

  it("keeps unclassified stderr at info and caps long lines", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({ command: "codex" });
    await transport.connect();
    child.stderr.write("\nplain diagnostic mentioning ERROR inside the message\n");
    child.stderr.write(`${"x".repeat(4001)}\n`);
    expect(transportLog.info).toHaveBeenCalledWith("app-server stderr", {
      line: "plain diagnostic mentioning ERROR inside the message",
    });
    expect(transportLog.info).toHaveBeenCalledWith("app-server stderr", {
      line: `${"x".repeat(4000)}…[truncated]`,
    });
    expect(transportLog.error).not.toHaveBeenCalled();
    expect(transportLog.warn).not.toHaveBeenCalled();
    await transport.close();
  });

  it("reports an app-server exit it did not ask for, and not one it did", async () => {
    const exited = vi.fn();
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: "/fixture/exit-codex" },
      onUnexpectedExit: exited,
    });
    const crashed = new MockCodexChildProcess();
    spawnMock.mockReturnValue(crashed);
    await transport.connect();
    for (let line = 1; line <= 25; line += 1) {
      crashed.stderr.write(`ERROR codex_core::panic: line ${line}\n`);
    }
    crashed.stderr.write(`${"x".repeat(600)}\n`);
    await new Promise((resolve) => setImmediate(resolve));
    crashed.emit("close", null, "SIGSEGV");
    expect(exited).toHaveBeenCalledTimes(1);
    const exit = exited.mock.calls[0]![0];
    expect(exit).toMatchObject({ code: null, signal: "SIGSEGV" });
    // A bounded tail, oldest first, with each line capped.
    expect(exit.stderrPreview).toHaveLength(20);
    expect(exit.stderrPreview[0]).toBe("ERROR codex_core::panic: line 7");
    expect(exit.stderrPreview.at(-1)).toBe(`${"x".repeat(500)}…[truncated]`);

    const stopped = new MockCodexChildProcess();
    spawnMock.mockReturnValue(stopped);
    await transport.connect();
    await transport.close();
    expect(stopped.killCalled).toBe(true);
    expect(exited).toHaveBeenCalledTimes(1);
  });

  it("stops further requests after a rejected refresh token", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: "/fixture/rejected-codex" },
    });
    await transport.connect();
    child.stderr.write("ERROR codex_login::auth::manager: Your access token could not be refreshed. Please log out and sign in again.\n");
    expect(() => transport.send(JSON.stringify({ id: 1, method: "model/list" })))
      .toThrow("sign in");
    expect(child.writes).toEqual([]);
    await transport.close();
    await expect(transport.connect()).rejects.toThrow("sign in");
    codexAuthState.verified("/fixture/rejected-codex");
    const recovered = new MockCodexChildProcess();
    spawnMock.mockReturnValue(recovered);
    await transport.connect();
    transport.send(JSON.stringify({ id: 2, method: "model/list" }));
    expect(recovered.writes).toHaveLength(1);
    await transport.close();
  });

  it("keeps recovery scoped to its profile and restricts it to authentication probes", async () => {
    const home = "/fixture/recovery-codex";
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    codexAuthState.reject(home);
    const rejected = vi.fn();
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: home },
      authenticationRecovery: true,
      onAuthenticationRejected: rejected,
    });
    await transport.connect();
    codexAuthState.reject("/fixture/other-codex");
    expect(rejected).not.toHaveBeenCalled();
    expect(() => transport.send(JSON.stringify({ id: 1, method: "turn/start" })))
      .toThrow("Only authentication verification");
    transport.send(JSON.stringify({ id: 2, method: "account/rateLimits/read" }));
    child.stderr.write("ERROR codex_login::auth::manager: Your access token could not be refreshed. Please log out and sign in again.\n");
    expect(rejected).toHaveBeenCalledWith(home);
    await transport.close();
    codexAuthState.verified(home);
    codexAuthState.verified("/fixture/other-codex");
  });

  it("uses RPC auth errors but ignores transcript text and unrelated MCP errors", async () => {
    const home = "/fixture/rpc-codex";
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: home },
    });
    await transport.connect();
    child.stdout.write(JSON.stringify({
      method: "item/agentMessage/delta",
      params: { delta: "Your access token could not be refreshed" },
    }) + "\n");
    transport.send(JSON.stringify({ id: 1, method: "mcpServer/oauth/login" }));
    transport.send(JSON.stringify({ id: 2, method: "account/rateLimits/read" }));
    child.stdout.write(JSON.stringify({ id: 1, error: { message: "MCP server: 401 Unauthorized" } }) + "\n");
    expect(codexAuthState.isBlocked(home)).toBe(false);
    child.stdout.write(JSON.stringify({
      id: 2,
      error: { message: "failed to fetch codex rate limits: GET https://chatgpt.com/backend-api/wham/usage failed: 401 Unauthorized" },
    }) + "\n");
    expect(codexAuthState.isBlocked(home)).toBe(true);
    await transport.close();
    codexAuthState.verified(home);
  });

  it.each(["rpc", "stderr", "turn"])("does not reject the Codex profile for MCP OAuth failures from %s", async (source) => {
    const home = "/fixture/mcp-auth-" + source;
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const rejected = vi.fn();
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { ...process.env, CODEX_HOME: home },
      onAuthenticationRejected: rejected,
    });
    await transport.connect();
    try {
      if (source === "rpc") {
        transport.send(JSON.stringify({ id: 1, method: "mcpServer/oauth/login", params: { name: "fixture" } }));
        child.stdout.write(JSON.stringify({ id: 1, error: {
          code: -32603, message: "invalid_refresh_token: Your access token could not be refreshed.",
        } }) + "\n");
      } else if (source === "turn") {
        transport.send(JSON.stringify({ id: 1, method: "turn/start" }));
        child.stdout.write(JSON.stringify({ id: 1, error: { message: "invalid_refresh_token" } }) + "\n");
      } else {
        child.stderr.write("2026-09-13T00:35:46Z ERROR rmcp::auth: invalid_refresh_token\n");
        child.stderr.write('"code": "invalid_refresh_token"\n');
      }
      expect(codexAuthState.isBlocked(home)).toBe(false);
      expect(rejected).not.toHaveBeenCalled();
      expect(() => transport.send(JSON.stringify({ id: 2, method: "model/list" }))).not.toThrow();
    } finally {
      await transport.close();
      codexAuthState.verified(home);
    }
  });

  it("prepends PwrAgent's bundled ripgrep for an external Codex runtime and its shell policy", async () => {
    const child = new MockCodexChildProcess();
    const bundledToolsDirectory = createBundledToolsDirectory();
    const externalRuntimeDirectory = path.join(os.tmpdir(), "custom-codex-runtime");
    const originalPath = [externalRuntimeDirectory, "/usr/bin"].join(path.delimiter);
    const resolveArgs = vi.fn((env: NodeJS.ProcessEnv) => [
      "-c",
      `shell_environment_policy.set.PATH=${JSON.stringify(env.PATH)}`,
    ]);
    spawnMock.mockReturnValue(child);
    try {
      const transport = new StdioJsonRpcTransport({
        command: "codex",
        bundledToolsDirectory,
        env: { PATH: originalPath },
        resolveArgs,
        resolveCommand: async () => ({
          command: path.join(externalRuntimeDirectory, "codex"),
          source: "path",
          version: "0.144.0",
        }),
      });

      await transport.connect();

      const expectedPath = [bundledToolsDirectory, originalPath].join(path.delimiter);
      expect(resolveArgs).toHaveBeenCalledWith({ PATH: expectedPath });
      expect(spawnMock).toHaveBeenCalledWith(
        path.join(externalRuntimeDirectory, "codex"),
        [
          "app-server",
          "-c",
          `shell_environment_policy.set.PATH=${JSON.stringify(expectedPath)}`,
        ],
        expect.objectContaining({
          env: expect.objectContaining({ PATH: expectedPath }),
        }),
      );

      await transport.close();
    } finally {
      rmSync(bundledToolsDirectory, { recursive: true, force: true });
    }
  });

  it("does not pass PwrAgent's renderer URL to the Codex app server", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: {
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        PATH: "/usr/bin",
      },
      resolveEnv: async () => ({
        ELECTRON_RENDERER_URL: "http://localhost:5175",
        PATH: "/opt/homebrew/bin:/usr/bin",
      }),
      resolveArgs: async (env) => {
        env.ELECTRON_RENDERER_URL = "http://localhost:5176";
        return [];
      },
    });

    await transport.connect();

    expect(spawnMock).toHaveBeenCalledWith(
      "codex",
      ["app-server"],
      expect.objectContaining({
        env: expect.objectContaining({ PATH: "/opt/homebrew/bin:/usr/bin" }),
      }),
    );
    expect(spawnMock.mock.calls[0]?.[2]?.env).not.toHaveProperty(
      "ELECTRON_RENDERER_URL",
    );

    await transport.close();
  });

  it("drops late sends after an intentional close", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
    expect(child.writes).toHaveLength(1);

    await transport.close();

    expect(child.killCalled).toBe(true);
    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } })),
    ).not.toThrow();
    expect(child.writes).toHaveLength(1);
  });

  it("rejects client requests after an intentional close", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    await transport.close();

    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "thread/list" })),
    ).toThrow("codex app server stdio not connected");
    expect(child.writes).toHaveLength(0);
  });

  it("does not treat a child error as proof that the process exited", async () => {
    const child = new MockCodexChildProcess();
    child.kill = vi.fn(() => {
      child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      return false;
    });
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    let closeSettled = false;
    const closePromise = transport.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();

    expect(closeSettled).toBe(false);
    child.exitCode = 1;
    child.emit("close");
    await closePromise;
    expect(closeSettled).toBe(true);
  });

  it("rejects close when no process exit is observed after SIGKILL", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockCodexChildProcess();
      child.kill = vi.fn(() => false);
      spawnMock.mockReturnValue(child);
      const transport = new StdioJsonRpcTransport({
        command: "codex",
        env: { PATH: process.env.PATH ?? "" },
      });

      await transport.connect();
      const closeResult = expect(transport.close()).rejects.toThrow(
        "child process tree did not accept SIGKILL",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await closeResult;
    } finally {
      vi.useRealTimers();
    }
  });

  it("still throws when the app-server exits unexpectedly", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    child.emit("close");

    expect(() =>
      transport.send(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
    ).toThrow("codex app server stdio not connected");
  });

  it("does not spawn after close cancels environment hydration", async () => {
    let resolveEnv: ((env: NodeJS.ProcessEnv) => void) | undefined;
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      resolveEnv: () =>
        new Promise((resolve) => {
          resolveEnv = resolve;
        }),
    });

    const connect = transport.connect();
    await Promise.resolve();
    await transport.close();
    resolveEnv?.({ PATH: process.env.PATH ?? "" });

    await expect(connect).rejects.toThrow("connection cancelled");
    expect(resolveCodexCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("cleans up a spawned child whose stdio pipes are unavailable", async () => {
    const child = new MockCodexChildProcess();
    Object.defineProperty(child, "stdout", { value: null });
    spawnMock.mockReturnValue(child);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await expect(transport.connect()).rejects.toThrow(
      "codex app server stdio pipes unavailable",
    );
    expect(child.killCalled).toBe(true);
  });

  it("supports an intentional reconnect after close completes", async () => {
    const firstChild = new MockCodexChildProcess();
    const secondChild = new MockCodexChildProcess();
    spawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: process.env.PATH ?? "" },
    });

    await transport.connect();
    await transport.close();
    await transport.connect();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await transport.close();
  });

  it("uses the shared command resolver instead of probing discovery directly", async () => {
    const firstChild = new MockCodexChildProcess();
    const secondChild = new MockCodexChildProcess();
    spawnMock
      .mockReturnValueOnce(firstChild)
      .mockReturnValueOnce(secondChild);
    const sharedResolver = vi.fn(async () => ({
      command: "/hydrated/bin/codex",
      source: "path" as const,
      version: "0.126.0",
    }));
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      env: { PATH: "/hydrated/bin:/usr/bin" },
      resolveCommand: sharedResolver,
    });

    await transport.connect();
    await transport.close();
    await transport.connect();

    expect(sharedResolver).toHaveBeenCalledTimes(2);
    expect(resolveCodexCommandMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      "/hydrated/bin/codex",
      ["app-server"],
      expect.any(Object),
    );
    await transport.close();
  });

  it("launches a resolved Windows batch shim through ComSpec", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const command = "C:\\nvm4w & tools\\nodejs\\codex.cmd";
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      args: ["--feature", "value & whoami"],
      env: {
        ComSpec: "C:\\Windows\\System32\\cmd.exe",
        PATH: "C:\\nvm4w & tools\\nodejs",
      },
      platform: "win32",
      resolveCommand: async () => ({
        command,
        source: "path",
        version: "0.126.0",
      }),
    });

    await transport.connect();

    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        expect.stringContaining(
          "C:\\nvm4w^ ^&^ tools\\nodejs\\codex.cmd ^\"app-server^\"",
        ),
      ],
      expect.objectContaining({
        windowsVerbatimArguments: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(spawnMock.mock.calls[0]?.[1]?.[3]).toContain(
      "^\"value^ ^&^ whoami^\"",
    );

    await transport.close();
  });

  // A PowerShell shim cannot host the app-server: npm's codex.ps1 branches on
  // `$MyInvocation.ExpectingInput`, and the transport holds stdin open as a
  // pipe, so it takes the `$input | & node …` branch and the `initialize`
  // handshake never returns. Verified on the Windows lab guest: powershell
  // times out, codex.cmd answers in ~1.5s.
  it("launches a resolved Windows PowerShell shim through its .cmd sibling", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const command = "C:\\nvm4w\\nodejs\\codex.ps1";
    const sibling = "C:\\nvm4w\\nodejs\\codex.cmd";
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      args: ["--feature", "value & whoami"],
      commandExists: (candidate) => candidate === sibling,
      env: {
        PATH: "C:\\nvm4w\\nodejs",
        SystemRoot: "C:\\Windows",
      },
      platform: "win32",
      resolveCommand: async () => ({
        command,
        source: "path",
        version: "0.144.0",
      }),
    });

    await transport.connect();

    const [spawnedCommand, spawnedArgs] = spawnMock.mock.calls[0] ?? [];
    expect(spawnedCommand).toMatch(/cmd\.exe$/i);
    expect(spawnedArgs?.join(" ")).toContain("codex.cmd");
    expect(spawnedArgs?.join(" ")).not.toContain("powershell");

    await transport.close();
  });

  it("keeps a PowerShell shim when no spawnable sibling is installed", async () => {
    const child = new MockCodexChildProcess();
    spawnMock.mockReturnValue(child);
    const command = "C:\\nvm4w\\nodejs\\codex.ps1";
    const transport = new StdioJsonRpcTransport({
      command: "codex",
      commandExists: () => false,
      env: { PATH: "C:\\nvm4w\\nodejs" },
      platform: "win32",
      resolveCommand: async () => ({
        command,
        source: "path",
        version: "0.144.0",
      }),
    });

    await transport.connect();

    // Failing loudly at spawn beats inventing a path that is not installed.
    expect(spawnMock.mock.calls[0]?.[0]).toBe(command);

    await transport.close();
  });
});
