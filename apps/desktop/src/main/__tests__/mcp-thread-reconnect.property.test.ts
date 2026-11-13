import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient } from "../mcp-connections/mcp-connection-rpc-client";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { sandboxerStub } from "./helpers/sandboxer-stub";
import { createDesktopBackendRegistry, registryModules } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";
import { attachSqliteWriteMetrics, isSqliteWriteMetricsEnabled, measureSqliteWrites } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

// The fixture owns the lifecycle oracle. Each launch and invocation is
// recorded independently of PwrAgent's inventories, grants and status maps.
const SERVER = String.raw`
const fs = require("node:fs");
const readline = require("node:readline");
fs.appendFileSync(process.argv[2], "start\n");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") send(m.id, {
    protocolVersion: m.params.protocolVersion, capabilities: { tools: {} },
    serverInfo: { name: "fixture-pwrdisk", version: "1.0.0" },
  });
  if (m.method === "tools/list") send(m.id, { tools: [
    { name: "pwrdisk_status", inputSchema: { type: "object", properties: {} } },
    { name: "pwrdisk_apply", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  ] });
  if (m.method === "tools/call") {
    if (m.params.name === "pwrdisk_apply") {
      // An operation may take effect even though the reply never arrives.
      fs.appendFileSync(process.argv[2], "ambiguous\n");
      process.exit(3);
    }
    fs.appendFileSync(process.argv[2], "call\n");
    send(m.id, { content: [{ type: "text", text: String(process.pid) }] });
  }
}).on("close", () => process.exit(0));
`;

async function scenario(actions: Array<"settings" | "discover" | "call" | "inspect">, failedReconnect = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-reconnect-"));
  const script = path.join(root, "server.cjs");
  const journal = path.join(root, "journal");
  fs.writeFileSync(script, SERVER);
  const stdio = { command: process.execPath, args: [script, journal], env: [] };
  const openExternal = vi.fn(async () => undefined);
  const service = new McpConnectionGatewayService({
    registry: new McpConnectionRegistry({ configPath: path.join(root, "config.toml") }),
    sandboxer: sandboxerStub(), leaseManager: null, openExternal,
    settings: {
      clearMcpConnectionCredentials: async () => undefined,
      clearPwrSnapMcpCredential: async () => undefined,
      resolveMcpConnectionCredentials: async () => undefined,
      resolvePwrSnapMcpCredential: async () => undefined,
      resolvePwrGitMcpCredential: async () => undefined,
      clearPwrGitMcpCredential: async () => undefined,
      saveMcpConnectionCredentials: async () => undefined,
      savePwrSnapMcpCredential: async () => undefined,
    },
    stdioSecrets: new McpStdioSecretVault({ settings: {
      resolveMcpStdioConnectionSecrets: async () => undefined,
      saveMcpStdioConnectionSecrets: async () => undefined,
      clearMcpStdioConnectionSecrets: async () => undefined,
    } }),
    readGatewaySelection: async () => [id],
  });
  let id = "";
  const scopeKey = JSON.stringify(["gateway", "codex", "fixture-thread"]);
  const signal = new AbortController().signal;
  const list = async () => await service.requestGatewayToolOperation({ connectionId: id, scopeKey, signal, operation: "gateway/tools/list" }) as McpGatewayTool[];
  const invoke = async (tool: McpGatewayTool) => await service.requestGatewayToolOperation({
    connectionId: id, scopeKey, signal, operation: "gateway/tools/call", invocation: { ...tool, arguments: {} },
  });
  const entries = () => fs.readFileSync(journal, "utf8").trim().split("\n");
  const dbFixture = createTempStateDb("mcp-reconnect-model-");
  const db = StateDb.open(dbFixture.dbPath);
  const overlayStore = new SqliteOverlayStore(db);
  const registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => undefined,
      onNotification: () => () => undefined,
      onPendingRequest: () => () => undefined,
    } as never,
    overlayStore,
    mcpConnectionService: service,
    isBootstrapMode: () => false,
  });
  vi.spyOn(registryModules(registry).threadMcpConnections, "listThreadMcpServers").mockResolvedValue({ backend: "codex", threadId: "fixture-thread", detail: "toolsAndAuthOnly", servers: [] });
  try {
    id = (await service.createConnection({ displayName: "PwrDisk fixture", stdio })).id;
    await overlayStore.setThreadMcpConnectionIds({ backend: "codex", threadId: "fixture-thread", connectionIds: [id] });
    const native = await service.registerBridge(id, "fixture-thread", undefined, "codex");
    const old = (await list())[0];
    const healthyScope = JSON.stringify(["gateway", "codex", "healthy-thread"]);
    const healthyList = async () => await service.requestGatewayToolOperation({ connectionId: id, scopeKey: healthyScope, signal, operation: "gateway/tools/list" });
    const healthy = await healthyList();
    const first = await invoke(old) as { content: Array<{ text: string }> };
    process.kill(Number(first.content[0].text), "SIGTERM");
    // Poll the owner's close observation, without making any request that
    // could start another process. Settings has its own, unrelated session.
    await vi.waitFor(async () => expect((await service.listConnections()).find((c) => c.id === id)?.localProcesses).toBe(1));
    let starts = 2;
    const settings = async () => {
      expect(await service.testStdioConnection({ connectionId: id, stdio })).toMatchObject({ ok: true, toolCount: 2 });
      starts += 1;
    };
    // The smallest counterexample is a successful Settings test after exit.
    await settings();
    for (const action of ["inspect", ...actions] as const) {
      if (action === "settings") await settings();
      if (action === "discover") await expect(list()).rejects.toThrow("connection ended");
      if (action === "call") await expect(invoke(old)).rejects.toThrow("connection ended");
      const report = await registry.describeThreadMcpConnections({ backend: "codex", threadId: "fixture-thread" });
      expect(report.connections[0]).toMatchObject({
        configured: true, enabled: true, state: "temporarily_unavailable",
        sessions: { native: "not_started", gateway: "ended" },
      });
      expect(entries().filter((entry) => entry === "start")).toHaveLength(starts);
      expect(entries().filter((entry) => entry === "call")).toHaveLength(1);
    }

    // Only the authenticated operator control plane retires the grants.
    // It starts nothing itself and changes no other thread's selection.
    if (!isSqliteWriteMetricsEnabled()) attachSqliteWriteMetrics({ db: db.raw, dbPath: db.raw.name });
    const { writes } = await measureSqliteWrites(async () => {
      await registry.setThreadMcpConnections({ backend: "codex", threadId: "fixture-thread", connectionIds: [id], reconnectConnectionId: id });
    });
    expectSqliteWriteBudget({ scenario: "mcp-thread-reconnect", writes, note: "Explicit operator reconnect changes in-memory grants and consent only: zero commits, 0 MB/day." });
    expect(entries().filter((entry) => entry === "start")).toHaveLength(starts);
    const replacement = await service.registerBridge(id, "fixture-thread", undefined, "codex");
    expect(replacement.server.env.PWRAGENT_MCP_CONNECTION_TOKEN).not.toBe(native.server.env.PWRAGENT_MCP_CONNECTION_TOKEN);
    // The old backend may release its handle after the replacement exists.
    native.revoke();
    expect(service.peekThreadBridge(id, "fixture-thread")).toEqual(replacement.server);
    if (failedReconnect) {
      fs.writeFileSync(script, 'require("node:fs").appendFileSync(process.argv[2], "start\\n"); process.exit(3);');
      await expect(list()).rejects.toThrow();
      starts += 1;
      for (let i = 0; i < 2; i += 1) {
        await expect(list()).rejects.toThrow("connection ended");
        await expect(invoke(old)).rejects.toThrow("connection ended");
      }
      expect(entries().filter((entry) => entry === "start")).toHaveLength(starts);
      fs.writeFileSync(script, SERVER);
      await registry.setThreadMcpConnections({ backend: "codex", threadId: "fixture-thread", connectionIds: [id], reconnectConnectionId: id });
    }
    const fresh = (await list())[0];
    expect(fresh.schemaRevision).not.toBe(old.schemaRevision);
    expect(fresh.consentRevision).not.toBe(old.consentRevision);
    expect(await healthyList()).toEqual(healthy);
    await expect(invoke(old)).rejects.toThrow("schema or authorization changed");
    expect(entries().filter((entry) => entry === "call")).toHaveLength(1);
    await expect(invoke(fresh)).resolves.toMatchObject({ content: [{ type: "text" }] });
    expect(entries().filter((entry) => entry === "call")).toHaveLength(2);
    const nativeAgain = await service.registerBridge(id, "fixture-thread", undefined, "codex");
    const nativeRpc = new ConnectionRpcClient(nativeAgain.server.env.PWRAGENT_MCP_CONNECTION_SOCKET, nativeAgain.server.env.PWRAGENT_MCP_CONNECTION_TOKEN);
    await expect(nativeRpc.request("tools/list", {})).resolves.toMatchObject({ tools: [{ name: "pwrdisk_status" }, { name: "pwrdisk_apply" }] });
    await expect(nativeRpc.request("tools/call", { name: "pwrdisk_status", arguments: {} })).resolves.toMatchObject({ content: [{ type: "text" }] });
    // Native execution loses its reply after an effect. Neither the gateway
    // nor explicit reconnect may replay that operation or reuse its revision.
    await expect(nativeRpc.request("tools/call", { name: "pwrdisk_apply", arguments: {} })).rejects.toThrow();
    await registry.setThreadMcpConnections({ backend: "codex", threadId: "fixture-thread", connectionIds: [id], reconnectConnectionId: id });
    await list();
    expect(entries().filter((entry) => entry === "ambiguous")).toHaveLength(1);
    expect(entries().filter((entry) => entry === "call")).toHaveLength(3);
    expect(await healthyList()).toEqual(healthy);
    expect(openExternal).not.toHaveBeenCalled();
  } finally {
    await registry.close();
    await service.close();
    db.close();
    fs.rmSync(dbFixture.tempDir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("local command recovery model", () => {
  it("keeps a stale thread ended after Settings succeeds, until operator reconnect", async () => {
    await scenario([]);
  });

  it("Settings success and read/call order cannot authorize an ended session", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom("settings" as const, "discover" as const, "call" as const, "inspect" as const), { maxLength: 5 }),
      async (actions) => await scenario(actions),
    ), { numRuns: 5 });
  });

  it("requires another operator reconnect after a command exits before initialization", async () => {
    await scenario([], true);
  });
});
