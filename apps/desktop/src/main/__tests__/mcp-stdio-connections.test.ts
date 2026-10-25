import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import { connect, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { mcpConnectionsForPeer } from "@pwragent/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient } from "../mcp-connections/mcp-connection-rpc-client";
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
      capabilities: { tools: {} },
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

function createService(fixture: Fixture, overrides: { gatewayEnabled?: () => boolean } = {}) {
  const registry = new McpConnectionRegistry({ configPath: path.join(fixture.root, "config.toml") });
  const secretSettings = memorySecretSettings();
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: overrides.gatewayEnabled ?? (() => true),
    leaseManager: null,
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
