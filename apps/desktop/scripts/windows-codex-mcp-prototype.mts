import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Duplex } from "node:stream";
import type { McpServerStatusUpdatedNotification } from "@pwrdrvr/codex-app-server-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentToolMcpServer } from "../src/main/agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../src/main/agent-tools/agent-tool-router";
import {
  CODEX_AGENT_TOOL_GRANT,
  readRegistrationPreface,
  type CodexAgentToolStdioConfig,
  type CodexIpcConnection,
} from "../src/main/agent-tools/codex-agent-tool-ipc";
import { buildCurrentTurnInputSourceTool } from "../src/main/agent-tools/current-turn-input-source-tool";

const tool = "get_current_turn_input_source";
const deadline = 20_000;

/** Quote one argument for CommandLineToArgvW / the Microsoft CRT. */
function windowsArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/gu, '$1$1\\"').replace(/(\\+)$/u, "$1$1") + '"';
}

function launch(supervisor: string, pipe: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const commandLine = [executable, ...args].map(windowsArgument).join(" ");
  const runtime = spawn(supervisor, ["--codex-windows-supervisor", pipe, executable, commandLine], {
    cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
  });
  runtime.stderr?.pipe(process.stderr, { end: false });
  return runtime;
}

function bridge(runtime: ChildProcess): Duplex {
  const readable = runtime.stdio[4];
  const writable = runtime.stdio[3];
  assert(readable && writable);
  const stream = Duplex.from({ readable, writable });
  // Owner and runtime death also close an idle or uninitialized channel.
  runtime.once("exit", () => stream.destroy());
  stream.on("error", () => stream.destroy());
  return stream;
}

function fixtureOwner(runtime: ChildProcess, channel: Duplex, helper: string, endpoint: string) {
  assert(runtime.pid);
  const grants = new Set<string>();
  let acceptConnection: CodexIpcConnection;
  let activeThread: string | undefined;
  let dispatches = 0;
  const router = new AgentToolRouter([buildCurrentTurnInputSourceTool(() => {
    dispatches++;
    return "desktop";
  })]);
  const server = new AgentToolMcpServer({
    verifyCodexThreadId: true,
    resolveCatalogs: () => [{ id: "app_management", router }],
    resolveCallContext: ({ threadId }) => threadId && threadId === activeThread
      ? { backend: "codex", threadId, turnId: "prototype-turn" }
      : undefined,
    createCodexIpcListener: (onConnection) => {
      acceptConnection = onConnection;
      return {
        configuration: async (token) => {
          grants.add(token);
          return {
            command: helper, args: ["--codex-stdio", endpoint], env: {
              [CODEX_AGENT_TOOL_GRANT]: token,
              PWRAGENT_CODEX_PROTOTYPE_SERVER_PID: String(runtime.pid),
            },
          };
        },
        revoke: (token) => { grants.delete(token); },
        close: async () => { grants.clear(); channel.destroy(); },
      };
    },
  });
  return {
    server,
    setActive: (threadId?: string) => { activeThread = threadId; },
    dispatches: () => dispatches,
    accept: async () => {
      if (channel.readableLength === 0) {
        await Promise.race([
          once(channel, "readable"),
          once(channel, "close").then(() => { throw new Error("prototype closed before admission"); }),
        ]);
      }
      const token = await readRegistrationPreface(channel);
      assert(token && grants.has(token), "admitted relay must present a scoped registration");
      await acceptConnection(channel, token,
        () => !channel.destroyed && grants.has(token) && runtime.exitCode === null && runtime.signalCode === null);
    },
  };
}

async function getLine(stream: NodeJS.ReadableStream) {
  const lines = createInterface({ input: stream });
  try {
    return await Promise.race([
      once(lines, "line").then(([line]) => line as string),
      once(lines, "close").then(() => { throw new Error("process closed before its reply"); }),
    ]);
  } finally { lines.close(); }
}

async function relayFixture() {
  const { config, threadId, wrongThread } = JSON.parse(await getLine(process.stdin)) as {
    config: CodexAgentToolStdioConfig; threadId: string; wrongThread: string;
  };
  const client = new Client({ name: "windows-native-fixture", version: "1" });
  await client.connect(new StdioClientTransport({
    command: config.command, args: config.args, env: config.env, stderr: "inherit",
  }));
  const names = (await client.listTools()).tools.map(({ name }) => name);
  const idle = await client.callTool({ name: tool, _meta: { threadId } });
  assert.equal(idle.isError, true);
  console.log("idle-rejected");
  assert.equal(await getLine(process.stdin), "active");
  const wrong = await client.callTool({ name: tool, _meta: { threadId: wrongThread } });
  const right = await client.callTool({ name: tool, _meta: { threadId } });
  assert.deepEqual(names, [tool]);
  assert.equal(wrong.isError, true);
  assert.deepEqual(right.structuredContent, { source: "desktop" });
  console.log("fixture-ok");
  // Keep the admitted relay alive until the owner closes the bridge.
}

async function proofOracle(helper: string, cwd: string) {
  const endpoint = `\\\\.\\pipe\\pwa-codex-prototype-${randomUUID()}`;
  const runtime = launch(helper, endpoint, process.execPath, [__filename, "--relay-fixture"], cwd, process.env);
  const closed = once(runtime, "exit");
  const channel = bridge(runtime);
  const owner = fixtureOwner(runtime, channel, helper, endpoint);
  try {
    const registered = await owner.server.registerCodexClient({ backend: "codex", threadId: "fixture-thread" });
    // Accept cannot begin until the debugger has processed the root startup.
    const ready = getLine(runtime.stdout!);
    assert.equal(await ready, "fixture-ready");
    const duplicate = launch(helper, endpoint, process.execPath, ["-e", "process.exit(0)"], cwd, process.env);
    const [duplicateCode] = await once(duplicate, "exit");
    assert.notEqual(duplicateCode, 0, "an occupied pipe must reject a second listener");
    const unowned = spawn(helper, registered.server.args, { env: { ...process.env, ...registered.server.env },
      stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let unownedBytes = 0;
    unowned.stdout.on("data", (chunk: Buffer) => { unownedBytes += chunk.length; });
    const [unownedCode] = await once(unowned, "exit");
    assert.notEqual(unownedCode, 0, "the correct grant is insufficient outside the selected launch");
    assert.equal(unownedBytes, 0);

    const idle = getLine(runtime.stdout!);
    const accepting = owner.accept();
    runtime.stdin!.write(JSON.stringify({ config: registered.server, threadId: "fixture-thread", wrongThread: "different-thread" }) + "\n");
    await accepting;
    assert.equal(await idle, "idle-rejected");
    assert.equal(owner.dispatches(), 0);
    owner.setActive("fixture-thread");
    const report = getLine(runtime.stdout!);
    runtime.stdin!.write("active\n");
    assert.equal(await report, "fixture-ok");
    assert.equal(owner.dispatches(), 1);
  } finally {
    runtime.stdin?.end();
    await owner.server.close();
    await closed;
  }
  const after = createConnection(endpoint);
  try {
    await assert.rejects(once(after, "connect"), { code: "ENOENT" }, "closing the owner must remove the pipe");
  } finally {
    after.destroy();
  }
  console.log("Windows native proof, first-instance protection, scope, and teardown passed");
}

function rpc(runtime: ChildProcess) {
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  const notifications = new EventEmitter();
  const lines = createInterface({ input: runtime.stdout! });
  lines.on("line", (line) => {
    const response = JSON.parse(line) as { id?: number; method?: string; params?: unknown };
    if (response.id !== undefined) pending.get(response.id)?.(response);
    else if (response.method) notifications.emit(response.method, response.params);
  });
  const send = (message: object) => runtime.stdin!.write(JSON.stringify(message) + "\n");
  return {
    waitForMcpStartup: (name: string) => new Promise<string | null>((resolve, reject) => {
      function finish(error: Error | null, threadId: string | null) {
        clearTimeout(timer);
        notifications.off("mcpServer/startupStatus/updated", read);
        if (error) reject(error);
        else resolve(threadId);
      }
      function read(event: McpServerStatusUpdatedNotification) {
        if (event.name !== name || event.status === "starting") return;
        const error = event.status === "ready" ? null : new Error(`Codex MCP startup: ${event.status} (${event.failureReason ?? "unknown"})`);
        finish(error, event.threadId);
      }
      const timer = setTimeout(() => finish(new Error("Codex did not report MCP startup"), null), deadline);
      notifications.on("mcpServer/startupStatus/updated", read);
    }),
    notify: (method: string) => send({ method }),
    request: <T,>(method: string, params: object): Promise<T> => {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Codex ${method} timed out`)); }, deadline);
        pending.set(requestId, (value) => {
          clearTimeout(timer);
          pending.delete(requestId);
          const response = value as { result: T; error?: { message?: string } };
          if (response.error) reject(new Error(`Codex ${method}: ${response.error.message}`));
          else resolve(response.result);
        });
        send({ id: requestId, method, params });
      });
    },
  };
}

async function realCodex(helper: string, codex: string, cwd: string) {
  const codexHome = join(cwd, "codex-home");
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), '[features]\napps = false\nplugins = false\nhooks = false\n');
  const endpoint = `\\\\.\\pipe\\pwa-codex-prototype-${randomUUID()}`;
  const runtime = launch(helper, endpoint, codex, ["app-server", "--listen", "stdio://"], cwd,
    { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined });
  const closed = once(runtime, "exit");
  const owner = fixtureOwner(runtime, bridge(runtime), helper, endpoint);
  try {
    const appServer = rpc(runtime);
    await appServer.request("initialize", { clientInfo: { name: "pwragent-windows-prototype", version: "1" }, capabilities: { experimentalApi: true } });
    appServer.notify("initialized");
    const registered = await owner.server.registerCodexClient({ backend: "codex" });
    const accepting = owner.accept();
    const ready = appServer.waitForMcpStartup("pwragent_apps");
    const starting = appServer.request<{ thread: { id: string } }>("thread/start", {
      cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      config: { mcp_servers: { pwragent_apps: { required: true, enabled: true, ...registered.server } } },
    });
    const [started, readyThreadId] = await Promise.all([starting, ready, accepting]);
    const threadId = started.thread.id;
    assert.equal(readyThreadId, threadId);
    registered.bindThread(threadId);
    const idle = await appServer.request<{ isError?: boolean; structuredContent?: { code?: string } }>("mcpServer/tool/call", {
      threadId, server: "pwragent_apps", tool, arguments: {}, _meta: { threadId },
    });
    assert.equal(idle.isError, true, "the real Codex call must be refused while the thread is idle");
    assert.equal(idle.structuredContent?.code, "forbidden");
    assert.equal(owner.dispatches(), 0);
    console.log("Real Codex launched the verified relay, reported MCP ready, and received the owner’s idle-call refusal");
  } finally {
    runtime.stdin?.end();
    await owner.server.close();
    await closed;
  }
}

async function main(helper: string, codex?: string) {
  const production = new AgentToolMcpServer({ resolveCatalogs: () => [], resolveCallContext: () => undefined });
  try {
    await assert.rejects(production.registerCodexClient({ backend: "codex" }), /macOS and Linux/u);
  } finally {
    await production.close();
  }
  const cwd = await mkdtemp(join(tmpdir(), "pwa-win-codex-"));
  try {
    await proofOracle(helper, cwd);
    if (codex) await realCodex(helper, codex, cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const args = process.argv.slice(2);
const timeout = setTimeout(() => { console.error("Windows MCP prototype exceeded its deadline"); process.exit(1); }, 60_000);
const run = args[0] === "--relay-fixture"
  ? (console.log("fixture-ready"), relayFixture())
  : main(args[0], args[1]);
void run.then(() => clearTimeout(timeout), (error) => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
