import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RuntimeLeaseManager } from "../runtime-lease-manager";
import { AppRuntimeInstanceStore } from "../state/app-runtime-instance-store";
import { StateDb } from "../state/state-db";
import {
  McpConnectionBrokerDiscovery,
} from "../mcp-connections/mcp-connection-broker-discovery";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import {
  PwrSnapConnectionService,
} from "../mcp-connections/pwrsnap-connection-service";

function createSettings() {
  let genericCredential: string | undefined;
  return {
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
  it("lets a non-owner process receive a thread bridge from the profile owner", async () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "pwragent-mcp-owner-broker-"),
    );
    const stateDb = StateDb.open(path.join(directory, "state.db"), {
      profileName: "dev",
    });
    const store = new AppRuntimeInstanceStore(stateDb);
    const discovery = new McpConnectionBrokerDiscovery({
      filePath: path.join(directory, "broker.json"),
    });
    const settings = createSettings();
    const owner = new PwrSnapConnectionService({
      bridgeEntryPath: "/owner/mcp-connection-bridge.js",
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
    const viewer = new PwrSnapConnectionService({
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
          datadog: {
            resourceUrl: "https://mcp.example.com/mcp",
            tokens: {
              access_token: "owner-only-access-token",
              refresh_token: "owner-only-refresh-token",
              token_type: "bearer",
            },
          },
        },
      }));
      const connection = await owner.createConnection({
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
      first.revoke();
    } finally {
      await viewer.close();
      await owner.close();
      stateDb.close();
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });
});
