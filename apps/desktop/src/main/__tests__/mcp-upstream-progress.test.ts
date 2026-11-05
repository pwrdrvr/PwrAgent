import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient, type McpBridgeProgress } from "../mcp-connections/mcp-connection-rpc-client";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";

// Short enough to outlast in a test, long enough to start a local command.
vi.mock("../mcp-connections/mcp-connection-timeouts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mcp-connections/mcp-connection-timeouts")>(),
  MCP_CONNECTION_TOOL_TIMEOUT_MS: 2_000,
  MCP_CONNECTION_TOOL_MAX_TOTAL_TIMEOUT_MS: 4_000,
}));

/*
 * Upstream MCP progress and cancellation, end to end through the gateway,
 * against a local command. `work` reports progress on a timer when the
 * request carries a token, `stall` answers late and reports nothing,
 * `endless` reports forever, and reading a resource never answers. The
 * server logs what it saw, so a test can assert which token reached it and
 * whether a cancel did. Nothing here runs a real MCP server.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + "\n");
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const timers = new Map();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
function result(id, text) {
  timers.delete(id);
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
}
function report(token, progress, total) {
  send({ jsonrpc: "2.0", method: "notifications/progress", params: {
    progressToken: token, progress, ...(total ? { total, message: "Step " + progress } : {}),
  } });
}
function handle(message) {
  if (message.id === undefined) {
    if (message.method === "notifications/cancelled") {
      log({ event: "cancelled", requestId: message.params.requestId });
      clearInterval(timers.get(message.params.requestId));
    }
    return;
  }
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "fixture-progress", version: "1.0.0" },
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: ["work", "stall", "endless"].map((name) => ({
      name, inputSchema: { type: "object", properties: { reports: { type: "number" }, everyMs: { type: "number" } } },
      annotations: { readOnlyHint: true },
    })) } });
  } else if (message.method === "tools/call") {
    const args = message.params.arguments || {};
    const token = message.params._meta && message.params._meta.progressToken;
    log({ event: "call", name: message.params.name, token });
    if (message.params.name === "stall") {
      setTimeout(() => result(message.id, "late"), args.ms);
      return;
    }
    let sent = 0;
    const timer = setInterval(() => {
      if (message.params.name === "work" && sent >= args.reports) {
        clearInterval(timer);
        result(message.id, "done after " + sent);
        return;
      }
      sent += 1;
      if (token !== undefined) report(token, sent, message.params.name === "work" ? args.reports : undefined);
    }, args.everyMs);
    timers.set(message.id, timer);
  } else if (message.method === "resources/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { resources: [] } });
  } else if (message.method === "resources/read") {
    log({ event: "read", requestId: message.id });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
}
`;

type LogEntry = {
  event: "call" | "cancelled" | "read";
  name?: string;
  token?: string | number;
  requestId?: string | number;
};

type Fixture = { root: string; binDir: string; log: string };

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-progress-"));
  temporaryDirectories.push(root);
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "fixture-progress-mcp"), FAKE_SERVER, { mode: 0o755 });
  return { root, binDir, log: path.join(root, "server.jsonl") };
}

function readLog(fixture: Fixture): LogEntry[] {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function createService(fixture: Fixture) {
  const selection: string[] = [];
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: () => true,
    leaseManager: null,
    readGatewaySelection: async () => selection,
    registry: new McpConnectionRegistry({ configPath: path.join(fixture.root, "config.toml") }),
    settings: {
      clearMcpConnectionCredentials: vi.fn(async () => undefined),
      clearPwrSnapMcpCredential: vi.fn(async () => undefined),
      clearPwrGitMcpCredential: vi.fn(async () => undefined),
      resolveMcpConnectionCredentials: vi.fn(async () => undefined),
      resolvePwrSnapMcpCredential: vi.fn(async () => undefined),
      resolvePwrGitMcpCredential: vi.fn(async () => undefined),
      saveMcpConnectionCredentials: vi.fn(async () => undefined),
      savePwrSnapMcpCredential: vi.fn(async () => undefined),
    },
    resolveStdioSearchEnv: async () => ({ PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}` }),
    stdioSecrets: new McpStdioSecretVault({ settings: {
      resolveMcpStdioConnectionSecrets: vi.fn(async () => undefined),
      saveMcpStdioConnectionSecrets: vi.fn(async () => undefined),
      clearMcpStdioConnectionSecrets: vi.fn(async () => undefined),
    } }),
  });
  services.push(service);
  const connection = await service.createConnection({
    displayName: "Fixture Progress",
    stdio: {
      command: "fixture-progress-mcp",
      args: [],
      cwd: fixture.root,
      env: [{ name: "FIXTURE_LOG", secret: false, value: fixture.log }],
    },
  });
  selection.push(connection.id);
  return { service, connectionId: connection.id };
}

async function bridgeFor(service: McpConnectionGatewayService, connectionId: string) {
  const registration = await service.registerBridge(connectionId, "thread-a");
  const env = registration.server.env;
  return new ConnectionRpcClient(env.PWRAGENT_MCP_CONNECTION_SOCKET, env.PWRAGENT_MCP_CONNECTION_TOKEN);
}

async function call(
  rpc: ConnectionRpcClient,
  name: string,
  args: Record<string, unknown>,
  options: { onProgress?: (progress: McpBridgeProgress) => void; token?: string } = {},
): Promise<string> {
  const result = await rpc.request(
    "tools/call",
    { name, arguments: args, ...(options.token ? { _meta: { progressToken: options.token } } : {}) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    options.onProgress,
  ) as { content: Array<{ text: string }> };
  return result.content[0]!.text;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("upstream MCP progress through managed connections", () => {
  it("reports the server's progress and keeps a call alive past the inactivity timeout", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId);
    const seen: McpBridgeProgress[] = [];

    // Six reports 500ms apart: 3s, past the 2s timeout.
    const text = await call(rpc, "work", { reports: 6, everyMs: 500 }, {
      token: "agent-token",
      onProgress: (progress) => seen.push(progress),
    });

    expect(text).toBe("done after 6");
    expect(seen).toEqual([1, 2, 3, 4, 5, 6].map((step) => ({ progress: step, total: 6, message: `Step ${step}` })));
    // The server answers the owner's token, never the agent's.
    const [entry] = readLog(fixture).filter((logged) => logged.event === "call");
    expect(entry?.token).toBeDefined();
    expect(entry?.token).not.toBe("agent-token");
  }, 15_000);

  it("still times out a call that reports nothing", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId);
    await call(rpc, "work", { reports: 0, everyMs: 1 }, { onProgress: () => undefined });

    await expect(call(rpc, "stall", { ms: 3_500 }, { onProgress: () => undefined }))
      .rejects.toThrow(/timed out/i);
  }, 15_000);

  it("stops a call that reports progress forever at the total cap", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId);
    await call(rpc, "work", { reports: 0, everyMs: 1 }, { onProgress: () => undefined });
    let reports = 0;
    const startedAt = Date.now();

    await expect(call(rpc, "endless", { everyMs: 300 }, { onProgress: () => { reports += 1; } }))
      .rejects.toThrow(/timed out|timeout/i);

    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(3_500);
    expect(elapsed).toBeLessThan(7_000);
    expect(reports).toBeGreaterThan(6);
    await waitFor(() => readLog(fixture).some((entry) => entry.event === "cancelled"), "the server to see the cancel");
  }, 15_000);

  it("leaves a request that did not opt in exactly as before", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId);

    const text = await call(rpc, "work", { reports: 2, everyMs: 50 }, { token: "agent-token" });

    expect(text).toBe("done after 2");
    // An older bridge's token passes through as it always did.
    expect(readLog(fixture).find((entry) => entry.event === "call")?.token).toBe("agent-token");
  }, 15_000);

  it("cancels a resource read on the server when the caller cancels", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = await bridgeFor(service, connectionId);
    const controller = new AbortController();

    const read = rpc.request("resources/read", { uri: "fixture://slow" }, controller.signal);
    await waitFor(() => readLog(fixture).some((entry) => entry.event === "read"), "the read to reach the server");
    controller.abort();

    await expect(read).rejects.toThrow(/cancelled/i);
    const readId = readLog(fixture).find((entry) => entry.event === "read")?.requestId;
    await waitFor(
      () => readLog(fixture).some((entry) => entry.event === "cancelled" && entry.requestId === readId),
      "the server to see the cancel",
    );
  }, 15_000);

  it("keeps a fixed gateway tool call alive while the server reports progress", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const scopeKey = JSON.stringify(["gateway", "codex", "thread-g"]);
    const signal = new AbortController().signal;
    const tools = await service.requestGatewayToolOperation({
      connectionId, scopeKey, operation: "gateway/tools/list", signal,
    }) as McpGatewayTool[];
    const tool = tools.find((entry) => entry.toolName === "work")!;
    let reports = 0;

    const result = await service.requestGatewayToolOperation({
      connectionId,
      scopeKey,
      operation: "gateway/tools/call",
      signal,
      invocation: {
        connectionId,
        serverName: tool.serverName,
        toolName: tool.toolName,
        schemaRevision: tool.schemaRevision,
        arguments: { reports: 6, everyMs: 500 },
      },
      onProgress: () => { reports += 1; },
    }) as { content: Array<{ text: string }> };

    expect(result.content[0]!.text).toBe("done after 6");
    expect(reports).toBe(6);
  }, 15_000);
});
