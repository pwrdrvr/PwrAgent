import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { AcpBackendId } from "@pwragent/shared";
import { describe, expect, it, vi } from "vitest";
import {
  AcpStdioJsonRpcTransport,
  type AcpStdioSpawn,
} from "../acp/acp-stdio-transport";
import type { AcpLaunchDescriptor } from "../acp/acp-launch-descriptor";

class MockAcpChildProcess extends EventEmitter {
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

function createDescriptor(overrides: Partial<AcpLaunchDescriptor> = {}): AcpLaunchDescriptor {
  return {
    backendId: "acp:test-agent" as AcpBackendId,
    registryId: "test-agent",
    distributionKind: "npx",
    command: "npx",
    args: ["--yes", "@example/acp-agent"],
    env: { ACP_TEST: "1" },
    cwd: "/repo",
    ...overrides,
  };
}

describe("AcpStdioJsonRpcTransport", () => {
  it("launches the descriptor command directly and writes newline JSON-RPC", async () => {
    const child = new MockAcpChildProcess();
    const spawnCalls: Array<Parameters<AcpStdioSpawn>> = [];
    const spawn: AcpStdioSpawn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return child;
    };
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor(),
      spawn,
    });

    const request = transport.request("initialize", { hello: true });
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    const [command, args, options] = spawnCalls[0];
    expect(command).toBe("npx");
    expect(args).toEqual(["--yes", "@example/acp-agent"]);
    expect(options).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
      cwd: "/repo",
    });
    expect(options.env).toMatchObject({ ACP_TEST: "1" });
    if (process.platform === "win32") {
      // The product only prepends the common Unix bin dirs to PATH on
      // non-Windows platforms (appendExecutableSearchPaths short-circuits on
      // win32), so assert those POSIX-only dirs are absent and the inherited
      // PATH is preserved verbatim instead.
      expect(String(options.env?.PATH)).not.toContain("/opt/homebrew/bin");
      expect(String(options.env?.PATH)).not.toContain("/usr/local/bin");
      expect(options.env?.PATH).toBe(process.env.PATH);
    } else {
      expect(String(options.env?.PATH)).toContain("/opt/homebrew/bin");
      expect(String(options.env?.PATH)).toContain("/usr/local/bin");
    }

    const envelope = JSON.parse(child.writes[0]) as { id: string; method: string };
    expect(child.writes[0]).toMatch(/\n$/);
    expect(envelope).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: { hello: true },
    });

    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: { ok: true } })}\n`,
    );
    await expect(request).resolves.toEqual({ ok: true });
  });

  it("launches a resolved Windows batch shim through ComSpec", async () => {
    const child = new MockAcpChildProcess();
    const spawnCalls: Array<Parameters<AcpStdioSpawn>> = [];
    const spawn: AcpStdioSpawn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return child;
    };
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor({
        command: "C:\\npm & tools\\qwen.cmd",
        args: ["--acp", "value & whoami"],
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
      platform: "win32",
      spawn,
    });

    await transport.connect();

    expect(spawnCalls[0]?.[0]).toMatch(/^C:\\Windows\\System32\\cmd\.exe$/i);
    expect(spawnCalls[0]?.[1].slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(spawnCalls[0]?.[1][3]).toContain(
      "C:\\npm^ ^&^ tools\\qwen.cmd ^\"--acp^\"",
    );
    expect(spawnCalls[0]?.[1][3]).toContain("^\"value^ ^&^ whoami^\"");
    expect(spawnCalls[0]?.[2]).toMatchObject({
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: true,
    });

    await transport.close();
  });

  it("does not pass PwrAgent's renderer URL to ACP agent sessions", async () => {
    const child = new MockAcpChildProcess();
    const spawnCalls: Array<Parameters<AcpStdioSpawn>> = [];
    const spawn: AcpStdioSpawn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return child;
    };
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor({
        env: {
          ACP_TEST: "1",
          ELECTRON_RENDERER_URL: "http://localhost:5175",
        },
      }),
      spawn,
    });

    await transport.connect();

    expect(spawnCalls[0]?.[2].env).toMatchObject({ ACP_TEST: "1" });
    expect(spawnCalls[0]?.[2].env).not.toHaveProperty("ELECTRON_RENDERER_URL");
    await transport.close();
  });

  it("adds Gemini session trust when launching persisted local descriptors", async () => {
    const child = new MockAcpChildProcess();
    const spawnCalls: Array<Parameters<AcpStdioSpawn>> = [];
    const spawn: AcpStdioSpawn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return child;
    };
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor({
        backendId: "acp:gemini" as AcpBackendId,
        registryId: "gemini",
        distributionKind: "local",
        command: "gemini",
        args: ["--acp"],
      }),
      spawn,
    });

    const request = transport.request("initialize");
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    expect(spawnCalls[0]?.[0]).toBe("gemini");
    expect(spawnCalls[0]?.[1]).toEqual(["--acp", "--skip-trust"]);
    expect(spawnCalls[0]?.[2].env).toEqual(
      expect.objectContaining({ GEMINI_CLI_TRUST_WORKSPACE: "true" }),
    );

    const envelope = JSON.parse(child.writes[0]) as { id: string };
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: { ok: true } })}\n`,
    );
    await expect(request).resolves.toEqual({ ok: true });
  });

  it("disables color when launching Grok ACP", async () => {
    const child = new MockAcpChildProcess();
    const spawnCalls: Array<Parameters<AcpStdioSpawn>> = [];
    const spawn: AcpStdioSpawn = (command, args, options) => {
      spawnCalls.push([command, args, options]);
      return child;
    };
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor({
        backendId: "acp:grok" as AcpBackendId,
        registryId: "grok",
        distributionKind: "local",
        command: "grok",
        args: ["agent", "stdio"],
      }),
      spawn,
    });

    const request = transport.request("initialize");
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));

    expect(spawnCalls[0]?.[0]).toBe("grok");
    expect(spawnCalls[0]?.[1]).toEqual(["agent", "stdio"]);
    expect(spawnCalls[0]?.[2].env).toEqual(
      expect.objectContaining({ NO_COLOR: "1" }),
    );

    const envelope = JSON.parse(child.writes[0]) as { id: string };
    child.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: { ok: true } })}\n`,
    );
    await expect(request).resolves.toEqual({ ok: true });
  });

  it("fans out ACP notifications until listeners unsubscribe", async () => {
    const child = new MockAcpChildProcess();
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor(),
      spawn: () => child,
    });
    const listener = vi.fn();
    const unsubscribe = transport.onNotification(listener);

    await transport.connect();
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s1" },
      })}\n`,
    );
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));

    unsubscribe();
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { sessionId: "s2" },
      })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listener).toHaveBeenCalledWith("session/update", { sessionId: "s1" });
    expect(listener).toHaveBeenCalledTimes(1);
    await transport.close();
    expect(child.killCalled).toBe(true);
  });

  it("forwards ACP JSON-RPC requests and writes handler responses", async () => {
    const child = new MockAcpChildProcess();
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor(),
      spawn: () => child,
    });
    const requests: Array<{
      method: string;
      params: Record<string, unknown>;
      id?: string | number;
    }> = [];
    transport.onRequest((method, params, id) => {
      requests.push({ method, params, id });
      return { ok: true };
    });

    await transport.connect();
    child.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: { sessionId: "s1" },
      })}\n`,
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      method: "session/request_permission",
      params: { sessionId: "s1" },
      id: 7,
    });
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));
    expect(JSON.parse(child.writes[0])).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    await transport.close();
  });

  it("prevents reconnect and late requests after close", async () => {
    const child = new MockAcpChildProcess();
    const spawn = vi.fn(() => child);
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor(),
      spawn,
    });

    await transport.connect();
    await transport.close();

    await expect(transport.connect()).rejects.toThrow("transport is closed");
    await expect(transport.request("session/new")).rejects.toThrow(
      "transport is closed",
    );
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("cleans up a child whose stdio pipes are unavailable", async () => {
    const child = new MockAcpChildProcess();
    Object.defineProperty(child, "stderr", { value: null });
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor(),
      spawn: () => child,
    });

    await expect(transport.connect()).rejects.toThrow(
      "ACP stdio pipes unavailable",
    );
    expect(child.killCalled).toBe(true);
  });

  it("reports an unexpected ACP exit with its exit code and stderr", async () => {
    const child = new MockAcpChildProcess();
    const transport = new AcpStdioJsonRpcTransport({
      launchDescriptor: createDescriptor({
        backendId: "acp:kimi" as AcpBackendId,
        registryId: "kimi",
      }),
      spawn: () => child,
    });

    const request = transport.request("initialize");
    await vi.waitFor(() => expect(child.writes).toHaveLength(1));
    child.stderr.write("\u001b[31mSelected model is no longer available.\u001b[0m\n");
    child.exitCode = 1;
    child.emit("close", 1, null);

    await expect(request).rejects.toThrow(
      "Kimi ACP agent exited unexpectedly (code 1): Selected model is no longer available.",
    );
  });

  it("waits for ACP exit and escalates when SIGTERM is resisted", async () => {
    vi.useFakeTimers();
    try {
      const child = new MockAcpChildProcess();
      child.kill = vi.fn(() => false);
      const transport = new AcpStdioJsonRpcTransport({
        launchDescriptor: createDescriptor(),
        spawn: () => child,
      });
      await transport.connect();

      const close = transport.close();
      await Promise.resolve();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
      child.signalCode = "SIGKILL";
      child.emit("close");

      await expect(close).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
