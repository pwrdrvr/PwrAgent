import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import {
  McpConnectionBrokerDiscovery,
} from "../mcp-connections/mcp-connection-broker-discovery";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import { MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS } from "../mcp-connections/mcp-connection-timeouts";
import {
  McpConnectionGatewayService,
} from "../mcp-connections/mcp-connection-gateway-service";

function createSettings() {
  let genericCredential: string | undefined;
  return {
    resolvePwrGitMcpCredential: vi.fn(async () => undefined),
    clearPwrGitMcpCredential: vi.fn(async () => undefined),
    setGenericCredential(value: string) {
      genericCredential = value;
    },
    clearMcpConnectionCredentials: vi.fn(async () => {
      genericCredential = undefined;
    }),
    clearPwrSnapMcpCredential: vi.fn(async () => undefined),
    resolveMcpConnectionCredentials: vi.fn(async () => genericCredential),
    resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
    saveMcpConnectionCredentials: vi.fn(async (value: string) => {
      genericCredential = value;
    }),
    savePwrSnapMcpCredential: vi.fn(async () => undefined),
  };
}

describe("MCP connection owner broker", () => {
  it.each(["interrupt", "deadline"])("closes stalled registration on gateway %s", async (reason) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-cancel-"));
    const socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\pwragent-mcp-cancel-${randomUUID()}`
      : path.join(directory, "broker.sock");
    const stateDb = openInMemoryStateDb({ profileName: "dev" });
    const store = new AppRuntimeInstanceStore(stateDb);
    const discovery = new McpConnectionBrokerDiscovery({ filePath: path.join(directory, "broker.json") });
    const lease = (instanceId: string, processId: number) => new RuntimeLeaseManager({
      cwd: directory, instanceId, processId, profileName: "dev", runtimeIdentityIsAlive: () => true, store,
    });
    const ownerLease = lease("owner", 101);
    ownerLease.acquire("mcp_connections");
    const viewer = new McpConnectionGatewayService({
      brokerDiscovery: discovery, leaseManager: lease("viewer", 202),
      registry: new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") }),
      settings: createSettings(),
    });
    const sockets = new Set<Socket>();
    let receivedRegistration = false;
    let closedRegistration = false;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => { sockets.delete(socket); closedRegistration = true; });
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.includes("\n")) receivedRegistration = JSON.parse(input).op === "broker/register";
        // Deliberately accept the request without ever returning a token.
      });
    });
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const gateway = new McpGatewayToolService({
      connections: viewer, selectedConnections: async () => ["fixture"], approve: async () => true,
    });
    let search: Promise<unknown> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      discovery.publish({ version: 1, ownerInstanceId: "owner", socketPath, brokerToken: "x".repeat(32), publishedAt: Date.now() });
      let failure: unknown;
      search = gateway.search({ query: "lookup" }, {
        backend: "codex", threadId: "thread", turnId: "turn", callId: "call", transport: "codex_dynamic_tool",
      }).catch((error: unknown) => { failure = error; });
      await vi.waitFor(() => expect(receivedRegistration).toBe(true));
      expect(timeout).toHaveBeenCalledWith(MCP_CONNECTION_TOOL_LIST_TIMEOUT_MS);
      if (reason === "deadline") deadline.abort(new DOMException("Discovery timed out.", "TimeoutError"));
      else gateway.cancel("codex", "thread", "turn");
      await vi.waitFor(() => {
        expect(failure).toMatchObject({ name: reason === "deadline" ? "TimeoutError" : "AbortError" });
        expect(closedRegistration).toBe(true);
      });
    } finally {
      timeout.mockRestore();
      for (const socket of sockets) socket.destroy();
      await search;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await viewer.close();
      ownerLease.release("mcp_connections");
      stateDb.close();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it.each(["datadog", "pwrgit"])("lets a non-owner process receive a %s bridge from the profile owner", async (id) => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-mcp-owner-broker-"),
    );
    const stateDb = openInMemoryStateDb({ profileName: "dev" });
    const store = new AppRuntimeInstanceStore(stateDb);
    const discovery = new McpConnectionBrokerDiscovery({
      filePath: path.join(directory, "broker.json"),
    });
    const settings = createSettings();
    const owner = new McpConnectionGatewayService({
      bridgeEntryPath: "/owner/mcp-connection-bridge.js",
      readGatewaySelection: async () => [id],
      brokerDiscovery: discovery,
      leaseManager: new RuntimeLeaseManager({
        cwd: "/tmp/PwrAgnt-owner",
        instanceId: "instance-owner",
        processId: 101,
        profileName: "dev",
        runtimeIdentityIsAlive: () => true,
        store,
      }),
      registry: new McpConnectionRegistry({
        configPath: path.join(directory, "config.toml"),
      }),
      settings,
    });
    const viewer = new McpConnectionGatewayService({
      bridgeEntryPath: "/viewer/mcp-connection-bridge.js",
      brokerDiscovery: discovery,
      leaseManager: new RuntimeLeaseManager({
        cwd: "/tmp/PwrAgnt-viewer",
        instanceId: "instance-viewer",
        processId: 202,
        profileName: "dev",
        runtimeIdentityIsAlive: () => true,
        store,
      }),
      registry: new McpConnectionRegistry({
        configPath: path.join(directory, "config.toml"),
      }),
      settings,
    });
    try {
      settings.setGenericCredential(JSON.stringify({
        version: 1,
        credentials: {
          [id]: {
            resourceUrl: id === "pwrgit" ? "http://127.0.0.1:51731/mcp" : "https://mcp.example.com/mcp",
            tokens: {
              access_token: "owner-only-access-token",
              refresh_token: "owner-only-refresh-token",
              token_type: "bearer",
            },
          },
        },
      }));
      const connection = id === "pwrgit" ? { id } : await owner.createConnection({
        displayName: "Datadog",
        serverUrl: "https://mcp.example.com/mcp",
      });
      await owner.start();

      await expect(viewer.listConnections()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: connection.id,
            configured: true,
          }),
        ]),
      );
      const first = await viewer.registerBridge(connection.id, "thread-1");
      const second = await viewer.registerBridge(connection.id, "thread-1");

      expect(first.server.args).toEqual(["/viewer/mcp-connection-bridge.js"]);
      expect(first.server.env.PWRAGENT_MCP_CONNECTION_SOCKET)
        .toBe(discovery.read()?.socketPath);
      expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN)
        .toBe(second.server.env.PWRAGENT_MCP_CONNECTION_TOKEN);
      expect(JSON.stringify(first.server)).not.toContain("owner-only");
      const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "owner fixture" }] }));
      Object.assign(owner, { connectUpstreamClient: async () => ({
        client: {
          listTools: async () => ({ tools: [{ name: "late_tool", inputSchema: { type: "object" } }] }),
          callTool, close: async () => undefined,
        },
        transport: { close: async () => undefined },
      }) });
      const gateway = { connectionId: connection.id, scopeKey: JSON.stringify(["gateway", "codex", "gateway-fixture"]), signal: new AbortController().signal };
      const catalog = await viewer.requestGatewayToolOperation({ ...gateway, operation: "gateway/tools/list" }) as McpGatewayTool[];
      expect(catalog[0].toolName).toBe("late_tool");
      await viewer.requestGatewayToolOperation({ ...gateway, operation: "gateway/tools/call", invocation: { ...catalog[0], arguments: {} } });
      expect(callTool).toHaveBeenCalledOnce();
      await owner.setConnectionEnabled(connection.id, false);
      await expect(viewer.requestGatewayToolOperation({ ...gateway, operation: "gateway/tools/call", invocation: { ...catalog[0], arguments: {} } }))
        .rejects.toThrow("not available");
      expect(callTool).toHaveBeenCalledOnce();
      first.revoke();
    } finally {
      await viewer.close();
      await owner.close();
      stateDb.close();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
