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
  killCalled = false;

  kill(): void {
    this.killCalled = true;
    this.emit("close");
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
});
