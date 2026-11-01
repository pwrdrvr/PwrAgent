import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { mcpConnectionsForPeer } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient } from "../mcp-connections/mcp-connection-rpc-client";
import { McpGatewayToolService } from "../mcp-connections/mcp-gateway-tool-service";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";

/*
 * A local command (stdio) MCP server, driven end to end through the gateway
 * against a fake server: a small Node script in a temp folder that speaks
 * newline-delimited JSON-RPC, records each process it starts, and can start
 * a grandchild, exit with output, or never answer. Nothing here runs a real
 * MCP server or an installed CLI.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const mode = process.env.FIXTURE_MODE || "serve";
const pidDir = process.env.FIXTURE_PID_DIR;
if (mode === "relay") {
  // This executable never changes when the desktop catalog/version changes.
  const socket = require("node:net").connect(process.env.FIXTURE_ENDPOINT);
  socket.on("connect", () => { process.stdin.pipe(socket); socket.pipe(process.stdout); });
  socket.on("end", () => process.exit(0));
  socket.on("error", () => { process.stderr.write("Start the desktop yourself.\n"); process.exit(1); });
  return;
}
if (pidDir) fs.writeFileSync(path.join(pidDir, "server-" + process.pid), "");
if (process.env.FIXTURE_GRANDCHILD === "1") {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  fs.writeFileSync(path.join(pidDir, "grandchild-" + child.pid), "");
}
if (mode === "exit") {
  process.stderr.write("boom: token " + process.env.FIXTURE_TOKEN + " was rejected\n");
  process.exit(3);
}
let calls = 0;
let buffer = "";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
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
function handle(message) {
  if (mode === "silent" || message.id === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: { listChanged: mode === "notify" }, ...(mode === "notify" ? { resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } } : {}) },
      serverInfo: { name: "fixture-files", version: "1.2.3" },
    } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [
      { name: "whoami", inputSchema: { type: "object", properties: {} } },
      { name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ] } });
  } else if (message.method === "tools/call") {
    calls += 1;
    const text = message.params.name === "echo"
      ? String(message.params.arguments.text)
      : JSON.stringify({
          pid: process.pid,
          calls,
          cwd: process.cwd(),
          token: process.env.FIXTURE_TOKEN,
          plain: process.env.FIXTURE_PLAIN,
          ambient: process.env.FIXTURE_AMBIENT ?? null,
          hasHome: Boolean(process.env.HOME),
        });
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } });
    if (mode === "notify") {
      for (const method of ["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed"]) send({ jsonrpc: "2.0", method, params: { _meta: { revision: 2 } } });
      send({ jsonrpc: "2.0", method: "notifications/resources/updated", params: { uri: "skill://fixture/SKILL.md" } });
    }
  } else if (message.method === "resources/subscribe" || message.method === "resources/unsubscribe") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
}
`;

const SECRET = "fixture-secret-0123456789";

type Fixture = {
  root: string;
  binDir: string;
  command: string;
  pidDir: string;
  workDir: string;
};

const services: McpConnectionGatewayService[] = [];
const temporaryDirectories: string[] = [];
const sockets: Socket[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-stdio-"));
  temporaryDirectories.push(root);
  const binDir = path.join(root, "bin");
  const pidDir = path.join(root, "pids");
  const workDir = path.join(root, "work");
  for (const directory of [binDir, pidDir, workDir]) fs.mkdirSync(directory);
  const command = path.join(binDir, "fixture-mcp");
  fs.writeFileSync(command, FAKE_SERVER, { mode: 0o755 });
  return { root, binDir, command, pidDir, workDir };
}

function memorySecretSettings() {
  let stored: string | undefined;
  return {
    resolveMcpStdioConnectionSecrets: vi.fn(async () => stored),
    saveMcpStdioConnectionSecrets: vi.fn(async (value: string) => {
      stored = value;
    }),
    clearMcpStdioConnectionSecrets: vi.fn(async () => {
      stored = undefined;
    }),
    read: () => stored,
  };
}

function createService(fixture: Fixture, overrides: { gatewayEnabled?: () => boolean; readGatewaySelection?: () => Promise<string[]> } = {}) {
  const registry = new McpConnectionRegistry({ configPath: path.join(fixture.root, "config.toml") });
  const secretSettings = memorySecretSettings();
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: overrides.gatewayEnabled ?? (() => true),
    leaseManager: null,
    readGatewaySelection: overrides.readGatewaySelection,
    registry,
    // OAuth storage for the built-in rows; no local command reads it.
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
    // The bare program name resolves against this PATH, never the login shell.
    resolveStdioSearchEnv: async () => ({ PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ""}` }),
    stdioSecrets: new McpStdioSecretVault({ settings: secretSettings }),
    stdioTestTimeoutMs: 1_500,
  });
  services.push(service);
  return { registry, secretSettings, service };
}

function launch(fixture: Fixture, env: Array<{ name: string; secret: boolean; value?: string }> = []) {
  return {
    command: "fixture-mcp",
    args: [],
    cwd: fixture.workDir,
    env: [{ name: "FIXTURE_PID_DIR", secret: false, value: fixture.pidDir }, ...env],
  };
}

function pidsOf(fixture: Fixture, kind: "server" | "grandchild"): number[] {
  return fs.readdirSync(fixture.pidDir)
    .filter((name) => name.startsWith(`${kind}-`))
    .map((name) => Number(name.slice(kind.length + 1)));
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Hold the bridge's attach lease the way a bridge child does, by hand. */
async function attach(socketPath: string, token: string): Promise<Socket> {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    sockets.push(socket);
    socket.setEncoding("utf8");
    socket.once("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify({ token, op: "attach" })}\n`));
    socket.once("data", (chunk: string) => {
      const response = JSON.parse(chunk.trim()) as { ok: boolean };
      if (response.ok) resolve(socket);
      else reject(new Error("attach refused"));
    });
  });
}

async function whoami(rpc: ConnectionRpcClient) {
  const result = await rpc.request("tools/call", { name: "whoami", arguments: {} }) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as {
    pid: number;
    calls: number;
    cwd: string;
    token?: string;
    plain?: string;
    ambient: string | null;
    hasHome: boolean;
  };
}

async function bridgeFor(service: McpConnectionGatewayService, connectionId: string, threadId: string) {
  const registration = await service.registerBridge(connectionId, threadId);
  const env = registration.server.env;
  return {
    rpc: new ConnectionRpcClient(env.PWRAGENT_MCP_CONNECTION_SOCKET, env.PWRAGENT_MCP_CONNECTION_TOKEN),
    socketPath: env.PWRAGENT_MCP_CONNECTION_SOCKET,
    token: env.PWRAGENT_MCP_CONNECTION_TOKEN,
  };
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("local command MCP connections", () => {
  it("tests a command once, reports the server, and leaves no process behind", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture);

    const result = await service.testStdioConnection({ stdio: launch(fixture) });

    expect(result).toMatchObject({
      ok: true,
      command: fixture.command,
      serverName: "fixture-files",
      serverVersion: "1.2.3",
      toolCount: 2,
    });
    const [pid] = pidsOf(fixture, "server");
    expect(pid).toBeDefined();
    await waitFor(() => !alive(pid!), "the tested server to stop");
    expect((await service.listConnections()).find((entry) => entry.kind === "stdio")).toBeUndefined();
  });

  it("names a missing program, an exit, and a silent server, with secrets masked", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture);

    const missing = await service.testStdioConnection({
      stdio: { ...launch(fixture), command: "no-such-fixture-program" },
    });
    expect(missing).toMatchObject({ ok: false, problem: "not_found" });

    const exited = await service.testStdioConnection({
      stdio: launch(fixture, [
        { name: "FIXTURE_MODE", secret: false, value: "exit" },
        { name: "FIXTURE_TOKEN", secret: true, value: SECRET },
      ]),
    });
    expect(exited).toMatchObject({ ok: false, problem: "exited" });
    expect(exited.ok ? "" : exited.output).toContain("boom: token •••• was rejected");
    expect(JSON.stringify(exited)).not.toContain(SECRET);

    const silent = await service.testStdioConnection({
      stdio: launch(fixture, [{ name: "FIXTURE_MODE", secret: false, value: "silent" }]),
    });
    expect(silent).toMatchObject({ ok: false, problem: "no_handshake" });
    for (const pid of pidsOf(fixture, "server")) {
      await waitFor(() => !alive(pid), `server ${pid} to stop`);
    }
  });

  it("refuses to start anything while the gateway is off", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture, { gatewayEnabled: () => false });

    await expect(service.testStdioConnection({ stdio: launch(fixture) }))
      .resolves.toMatchObject({ ok: false, problem: "gateway_off" });
    expect(pidsOf(fixture, "server")).toEqual([]);
  });

  it("stores the command and plain variables in config, and the secret only encrypted", async () => {
    const fixture = makeFixture();
    const { registry, secretSettings, service } = createService(fixture);

    const connection = await service.createConnection({
      displayName: "Project files",
      stdio: launch(fixture, [
        { name: "FIXTURE_PLAIN", secret: false, value: "visible" },
        { name: "FIXTURE_TOKEN", secret: true, value: SECRET },
      ]),
    });

    const config = fs.readFileSync(path.join(fixture.root, "config.toml"), "utf8");
    expect(config).toContain(`transport = "stdio"`);
    expect(config).toContain(`command = "${fixture.command}"`);
    expect(config).toContain("FIXTURE_PLAIN=visible");
    expect(config).toContain("FIXTURE_TOKEN");
    expect(config).not.toContain(SECRET);
    expect(secretSettings.read()).toContain(SECRET);
    expect(connection).toMatchObject({ kind: "stdio", authMode: "none", configured: true });
    expect(registry.get(connection.id)?.stdio?.env.find((entry) => entry.secret)?.value).toBeUndefined();
    // A peer sees the name and kind, never the launch.
    const [peer] = mcpConnectionsForPeer([connection]);
    expect(peer).not.toHaveProperty("stdio");

    await service.removeConnection(connection.id);
    expect(secretSettings.read()).toBeUndefined();
  });

  it("runs one process per thread, stops it when the bridge lets go, and takes its group with it", async () => {
    vi.stubEnv("FIXTURE_AMBIENT", "from-the-app");
    const fixture = makeFixture();
    const { service } = createService(fixture);
    const connection = await service.createConnection({
      displayName: "Project files",
      stdio: launch(fixture, [
        { name: "FIXTURE_GRANDCHILD", secret: false, value: "1" },
        { name: "FIXTURE_TOKEN", secret: true, value: SECRET },
      ]),
    });

    const threadA = await bridgeFor(service, connection.id, "thread-a");
    const leaseA = await attach(threadA.socketPath, threadA.token);
    const first = await whoami(threadA.rpc);
    const second = await whoami(threadA.rpc);
    // The same server answers both calls, so its state carries between them.
    expect(second).toMatchObject({ pid: first.pid, calls: 2 });
    expect(first).toMatchObject({
      cwd: fs.realpathSync(fixture.workDir),
      token: SECRET,
      ambient: null,
      hasHome: true,
    });

    const threadB = await bridgeFor(service, connection.id, "thread-b");
    const otherThread = await whoami(threadB.rpc);
    expect(otherThread.pid).not.toBe(first.pid);
    expect(otherThread.calls).toBe(1);
    const status = (await service.listConnections()).find((entry) => entry.id === connection.id);
    expect(status?.localProcesses).toBe(2);

    const grandchildren = pidsOf(fixture, "grandchild");
    expect(grandchildren).toHaveLength(2);
    leaseA.destroy();
    await waitFor(() => !alive(first.pid), "thread A's server to stop");
    await waitFor(() => grandchildren.filter(alive).length === 1, "thread A's grandchild to stop");
    expect(alive(otherThread.pid)).toBe(true);

    await service.closeThreadSessions("thread-b", [connection.id]);
    await waitFor(() => !alive(otherThread.pid), "thread B's server to stop");
    await waitFor(() => grandchildren.every((pid) => !alive(pid)), "every grandchild to stop");
  });

  it("stops running copies when the connection is disabled, edited, or the gateway closes", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture);
    const connection = await service.createConnection({
      displayName: "Project files",
      stdio: launch(fixture),
    });
    const bridge = await bridgeFor(service, connection.id, "thread-a");

    const running = await whoami(bridge.rpc);
    await service.setConnectionEnabled(connection.id, false);
    await waitFor(() => !alive(running.pid), "the disabled server to stop");
    await expect(whoami(bridge.rpc)).rejects.toThrow();

    await service.setConnectionEnabled(connection.id, true);
    const again = await bridgeFor(service, connection.id, "thread-a");
    const beforeEdit = await whoami(again.rpc);
    await service.updateConnection({
      connectionId: connection.id,
      stdio: launch(fixture, [{ name: "FIXTURE_PLAIN", secret: false, value: "edited" }]),
    });
    await waitFor(() => !alive(beforeEdit.pid), "the edited server to stop");
    const afterEdit = await whoami(again.rpc);
    expect(afterEdit.plain).toBe("edited");
    expect(afterEdit.pid).not.toBe(beforeEdit.pid);

    // The edit dialog always sends the launch. A rename that leaves it alone
    // keeps the server and its state.
    await service.updateConnection({
      connectionId: connection.id,
      displayName: "Renamed files",
      stdio: launch(fixture, [{ name: "FIXTURE_PLAIN", secret: false, value: "edited" }]),
    });
    expect(await whoami(again.rpc)).toMatchObject({ pid: afterEdit.pid, calls: 2 });

    await service.close();
    await waitFor(() => !alive(afterEdit.pid), "the server to stop on shutdown");
  });

  it("keeps a stored secret when an edit leaves it blank, and reports one it cannot read", async () => {
    const fixture = makeFixture();
    const { secretSettings, service } = createService(fixture);
    const connection = await service.createConnection({
      displayName: "Project files",
      stdio: launch(fixture, [{ name: "FIXTURE_TOKEN", secret: true, value: SECRET }]),
    });

    await service.updateConnection({
      connectionId: connection.id,
      displayName: "Renamed",
      stdio: launch(fixture, [{ name: "FIXTURE_TOKEN", secret: true }]),
    });
    const bridge = await bridgeFor(service, connection.id, "thread-a");
    expect((await whoami(bridge.rpc)).token).toBe(SECRET);

    // A variable that shares a name with an Object member is still a key.
    await service.updateConnection({
      connectionId: connection.id,
      stdio: launch(fixture, [
        { name: "FIXTURE_TOKEN", secret: true },
        { name: "constructor", secret: true },
      ]),
    }).then(
      () => { throw new Error("a blank new secret must be refused"); },
      (error: Error) => expect(error.message).toContain("Enter a value for constructor"),
    );

    await secretSettings.clearMcpStdioConnectionSecrets();
    const status = (await service.listConnections()).find((entry) => entry.id === connection.id);
    expect(status).toMatchObject({ configured: false });
    expect(status?.detail).toContain("FIXTURE_TOKEN");
  });
});


describe.skipIf(process.platform === "win32")("desktop-owned MCP lifecycle through an unchanged relay", () => {
  it("keeps a healthy thread's revisions and pending approval when another session exits", async () => {
    const fixture = makeFixture();
    let id = "";
    const { service } = createService(fixture, { readGatewaySelection: async () => [id] });
    const connection = await service.createConnection({ displayName: "Independent sessions", stdio: launch(fixture) });
    id = connection.id;
    const signal = new AbortController().signal;
    const scope = (thread: string) => JSON.stringify(["gateway", "codex", thread]);
    const list = async (thread: string) => await service.requestGatewayToolOperation({
      connectionId: id, scopeKey: scope(thread), operation: "gateway/tools/list", signal,
    }) as McpGatewayTool[];
    await list("exiting-thread");
    const exiting = await bridgeFor(service, id, scope("exiting-thread"));
    let ended = false;
    await exiting.rpc.attach(5_000, (event) => { if (event.method === "connection/closed") ended = true; });
    const identity = await whoami(exiting.rpc);
    const healthy = await list("healthy-thread");
    const echo = healthy.find((entry) => entry.toolName === "echo")!;
    const cached = await service.listConnectionTools({ connectionId: id });
    const starts = pidsOf(fixture, "server").length;
    let release!: (approved: boolean) => void;
    const approval = new Promise<boolean>((resolve) => { release = resolve; });
    const approve = vi.fn(async () => await approval);
    const gateway = new McpGatewayToolService({ connections: service, selectedConnections: async () => [id], approve });
    const outcome = gateway.call({ ...echo, arguments: { text: "still approved" } }, {
      backend: "codex", threadId: "healthy-thread", turnId: "turn", callId: "call", transport: "codex_dynamic_tool",
    }).then((result) => ({ result }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(approve).toHaveBeenCalledOnce());
      expect(pidsOf(fixture, "server")).toContain(identity.pid);
      process.kill(identity.pid, "SIGTERM");
      await vi.waitFor(() => expect(ended).toBe(true));
      await expect(list("exiting-thread")).rejects.toThrow("turn this connection off and on");
      const freshInventory = await service.listConnectionTools({ connectionId: id });
      expect(freshInventory.fetchedAt).toBeGreaterThan(cached.fetchedAt);
      expect(pidsOf(fixture, "server")).toHaveLength(starts + 1);
      expect(await list("healthy-thread")).toEqual(healthy);
      release(true);
      await expect(outcome).resolves.toMatchObject({ result: { result: { content: [{ text: "still approved" }] } } });
      expect(approve).toHaveBeenCalledOnce();
    } finally {
      release(false);
      await outcome;
    }
  });

  it("forwards supported discovery notifications and resource subscriptions over the live attach socket", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture);
    const connection = await service.createConnection({ displayName: "Changing catalog", stdio: launch(fixture, [
      { name: "FIXTURE_MODE", secret: false, value: "notify" },
    ]) });
    const bridge = await bridgeFor(service, connection.id, "notification-thread");
    const events: Array<{ method: string }> = [];
    expect(await bridge.rpc.attach(5_000, (event) => events.push(event))).toBe(true);
    expect(await bridge.rpc.request("describe")).toMatchObject({ capabilities: { tools: { listChanged: true }, resources: { subscribe: true } } });
    await bridge.rpc.request("resources/subscribe", { uri: "skill://fixture/SKILL.md" });
    const before = await service.listConnectionTools({ connectionId: connection.id });
    await bridge.rpc.request("tools/call", { name: "echo", arguments: { text: "notify" }, _meta: { "fixture/approval": "unchanged" } });
    await vi.waitFor(() => expect(events).toHaveLength(4));
    expect(events.map((event) => event.method)).toEqual(["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed", "notifications/resources/updated"]);
    const after = await service.listConnectionTools({ connectionId: connection.id });
    expect(after.fetchedAt).toBeGreaterThan(before.fetchedAt);
    await bridge.rpc.request("resources/unsubscribe", { uri: "skill://fixture/SKILL.md" });
  });

  it("requires explicit reconnect after EOF and rejects an approval from the old session", async () => {
    const fixture = makeFixture();
    const endpoint = path.join(fixture.root, "desktop.sock");
    let version = "2.0.0";
    let catalog = [{ name: "remove", inputSchema: { type: "object" as const }, annotations: { destructiveHint: true } }];
    const peers = new Set<Socket>();
    const methods: string[] = [];
    const desktop = createServer((peer) => {
      peers.add(peer);
      peer.on("close", () => peers.delete(peer));
      let buffer = "";
      peer.setEncoding("utf8");
      peer.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const request = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          methods.push(request.method);
          if (request.id === undefined) continue;
          const result = request.method === "initialize" ? {
            protocolVersion: request.params.protocolVersion, capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture-desktop", version }, instructions: `Read skill ${version}.`,
            _meta: { "com.pwrdrvr.pwrdisk/interface": { owner: "desktop", desktopVersion: version, relayVersion: "0.1.0" } },
          } : request.method === "tools/list" ? { tools: catalog }
            : { content: [{ type: "text", text: "removed fixture" }] };
          peer.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
          // Thread sessions offer forms only; URL mode stays unsupported.
          if (request.method === "initialize") expect(request.params.capabilities.elicitation).toEqual({ form: {} });
        }
      });
    });
    await new Promise<void>((resolve) => desktop.listen(endpoint, resolve));
    let id = "";
    const { service } = createService(fixture, { readGatewaySelection: async () => [id] });
    const connection = await service.createConnection({ displayName: "Fixture desktop", stdio: launch(fixture, [
      { name: "FIXTURE_MODE", secret: false, value: "relay" },
      { name: "FIXTURE_ENDPOINT", secret: false, value: endpoint },
    ]) });
    id = connection.id;
    const scope = JSON.stringify(["gateway", "codex", "desktop-thread"]);
    const base = { connectionId: id, scopeKey: scope, signal: new AbortController().signal };
    let approve!: (value: boolean) => void;
    const approval = new Promise<boolean>((resolve) => { approve = resolve; });
    const asked = vi.fn(async () => await approval);
    const gateway = new McpGatewayToolService({ connections: service, selectedConnections: async () => [id], approve: asked });
    try {
      const first = await service.requestGatewayToolOperation({ ...base, operation: "gateway/tools/list" }) as McpGatewayTool[];
      expect(first[0].serverIdentity).toMatchObject({ serverInfo: { version: "2.0.0" }, metadata: { "com.pwrdrvr.pwrdisk/interface": { owner: "desktop", relayVersion: "0.1.0" } } });
      const pending = gateway.call({ ...first[0], arguments: {} }, { backend: "codex", threadId: "desktop-thread", turnId: "turn", callId: "call", transport: "codex_dynamic_tool" });
      const outcome = pending.catch((error: unknown) => error);
      await vi.waitFor(() => expect(asked).toHaveBeenCalledOnce());
      for (const peer of peers) peer.end();
      await vi.waitFor(async () => expect((await service.listConnections()).find((entry) => entry.id === id)?.localProcesses).toBeUndefined());
      approve(true);
      expect(await outcome).toMatchObject({ message: expect.stringContaining("turn this connection off and on") });
      await expect(service.requestGatewayToolOperation({ ...base, operation: "gateway/tools/list" })).rejects.toThrow("Start the desktop yourself");
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(0);
      // The existing thread selection control calls this when deselected.
      await service.closeThreadSessions("desktop-thread", [id]);
      version = "3.0.0";
      catalog = [...catalog, { ...catalog[0], name: "new_tool" }];
      const refreshed = await service.requestGatewayToolOperation({ ...base, operation: "gateway/tools/list" }) as McpGatewayTool[];
      expect(refreshed.map((tool) => tool.toolName)).toEqual(["remove", "new_tool"]);
      expect(refreshed[0].schemaRevision).not.toBe(first[0].schemaRevision);
      expect(refreshed[0].serverIdentity?.serverInfo?.version).toBe("3.0.0");
      const native = await bridgeFor(service, id, scope);
      expect(await native.rpc.request("describe")).toMatchObject({
        instructions: "Read skill 3.0.0.",
        metadata: { "com.pwrdrvr.pwrdisk/interface": { desktopVersion: "3.0.0", relayVersion: "0.1.0" } },
      });
      await expect(service.requestGatewayToolOperation({ ...base, operation: "gateway/tools/call", invocation: { ...first[0], arguments: {} } })).rejects.toThrow("schema or authorization changed");
      expect(methods.filter((method) => method === "tools/call")).toHaveLength(0);
    } finally {
      approve(false);
      await service.close();
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => desktop.close(() => resolve()));
    }
  });

  it("reports absence without attempting to launch the desktop", async () => {
    const fixture = makeFixture();
    const { service } = createService(fixture);
    const result = await service.testStdioConnection({ stdio: launch(fixture, [
      { name: "FIXTURE_MODE", secret: false, value: "relay" },
      { name: "FIXTURE_ENDPOINT", secret: false, value: path.join(fixture.root, "absent.sock") },
    ]) });
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining("Start the desktop yourself") });
  });
});
