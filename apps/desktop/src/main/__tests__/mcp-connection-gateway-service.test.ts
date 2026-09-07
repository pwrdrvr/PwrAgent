import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpConnectionGatewayService,
} from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";

function createSettings(initial?: string) {
  let credential = initial;
  let connectionCredentials: string | undefined;
  return {
    clearMcpConnectionCredentials: vi.fn(async () => {
      connectionCredentials = undefined;
    }),
    clearPwrSnapMcpCredential: vi.fn(async () => {
      credential = undefined;
    }),
    resolveMcpConnectionCredentials: vi.fn(async () => connectionCredentials),
    resolvePwrSnapMcpCredential: vi.fn(async () => credential),
    saveMcpConnectionCredentials: vi.fn(async (value: string) => {
      connectionCredentials = value;
    }),
    savePwrSnapMcpCredential: vi.fn(async (value: string) => {
      credential = value;
    }),
  };
}

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];

function temporaryRegistry(): McpConnectionRegistry {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-gateway-"));
  temporaryDirectories.push(directory);
  return new McpConnectionRegistry({
    configPath: path.join(directory, "config.toml"),
  });
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("McpConnectionGatewayService", () => {
  it("distinguishes an absent install from a running MCP endpoint", async () => {
    const absent = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      resolveInstallPaths: () => [],
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(absent);

    await expect(absent.readStatus()).resolves.toMatchObject({
      availability: "not_installed",
      configured: false,
    });

    const running = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => new Response("unauthorized", { status: 401 })),
      resolveInstallPaths: () => [],
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
    });
    services.push(running);

    await expect(running.readStatus()).resolves.toMatchObject({
      availability: "running",
      configured: true,
    });
  });

  it("opens an installed PwrSnap and explains when Local Agent Access is off", async () => {
    const openPath = vi.fn(async () => "");
    const service = new McpConnectionGatewayService({
      fetchFn: vi.fn(async () => {
        throw new Error("connection refused");
      }),
      openPath,
      launchPollAttempts: 0,
      resolveInstallPaths: () => [fileURLToPath(import.meta.url)],
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    await expect(service.connect()).resolves.toMatchObject({
      outcome: "needs_local_agent_access",
      status: { availability: "installed", configured: false },
    });
    expect(openPath).toHaveBeenCalledOnce();
  });

  it("reuses one revocable stdio bridge grant for a configured thread", async () => {
    const service = new McpConnectionGatewayService({
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
    });
    services.push(service);

    const first = await service.registerBridge("pwrsnap", "thread-1");
    const second = await service.registerBridge("pwrsnap", "thread-1");

    expect(second.server).toEqual(first.server);
    expect(first.server).toMatchObject({
      name: "pwrsnap",
      command: process.execPath,
      args: ["/test/mcp-connection-bridge.js"],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        PWRAGENT_MCP_CONNECTION_NAME: "pwrsnap",
      },
    });
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).toBeTruthy();
    expect(first.server.env.PWRAGENT_MCP_CONNECTION_SOCKET).toBeTruthy();
  });

  it("names the switch that is withholding a connection", async () => {
    const registry = temporaryRegistry();
    const connection = registry.create({
      displayName: "Datadog",
      serverUrl: "https://mcp.datadoghq.com/mcp",
    });
    let gatewayEnabled = true;
    const service = new McpConnectionGatewayService({
      bridgeEntryPath: "/test/mcp-connection-bridge.js",
      gatewayEnabled: () => gatewayEnabled,
      registry,
      settings: createSettings(),
      leaseManager: null,
    });
    services.push(service);

    gatewayEnabled = false;
    await expect(service.registerBridge(connection.id, "thread-1"))
      .rejects.toThrow("MCP gateway is turned off");

    gatewayEnabled = true;
    registry.setEnabled(connection.id, false);
    // A parked connection and a gateway that is off are different problems
    // with different fixes, so they cannot share one message.
    await expect(service.registerBridge(connection.id, "thread-1"))
      .rejects.toThrow("Datadog is not available to threads");

    // Existence is still answerable while a connection is withheld;
    // otherwise the operator could never turn it back on.
    await expect(service.setConnectionEnabled(connection.id, true))
      .resolves.toMatchObject({ id: connection.id, enabled: true });
  });

  it("keeps blocking upstream tool calls alive beyond the SDK default", async () => {
    const callTool = vi.fn(async () => ({ content: [] }));
    const service = new McpConnectionGatewayService({
      settings: createSettings(JSON.stringify({
        tokens: { access_token: "secret", token_type: "bearer" },
      })),
      leaseManager: null,
    });
    services.push(service);
    const token = "test-token";
    Object.assign(service, {
      upstreamSessions: new Map([[token, {
        client: { callTool, close: vi.fn(async () => undefined) },
        transport: { close: vi.fn(async () => undefined) },
      }]]),
    });

    const bridge = service as unknown as {
      dispatchBridgeOperation: (
        token: string,
        grant: { connectionId: string; threadId?: string },
        operation: unknown,
        params: unknown,
        signal?: AbortSignal,
      ) => Promise<unknown>;
    };
    await bridge.dispatchBridgeOperation(
      token,
      { connectionId: "pwrsnap", threadId: "thread-1" },
      "tools/call",
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-1", instruction: "Add an arrow" },
      },
    );

    expect(callTool).toHaveBeenCalledWith(
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-1", instruction: "Add an arrow" },
      },
      undefined,
      { timeout: 720_000 },
    );

    const abortController = new AbortController();
    await bridge.dispatchBridgeOperation(
      token,
      { connectionId: "pwrsnap", threadId: "thread-1" },
      "tools/call",
      {
        name: "pwrsnap_image_edit_send",
        arguments: { captureId: "cap-2", instruction: "Add a label" },
      },
      abortController.signal,
    );
    expect(callTool).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: "pwrsnap_image_edit_send" }),
      undefined,
      { signal: abortController.signal, timeout: 720_000 },
    );
  });
});
