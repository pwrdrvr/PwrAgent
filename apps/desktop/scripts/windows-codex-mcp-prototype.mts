import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AgentToolMcpServer } from "../src/main/agent-tools/agent-tool-mcp-server";
import { AgentToolRouter } from "../src/main/agent-tools/agent-tool-router";
import { bindCodexAgentToolRuntime, type CodexAgentToolStdioConfig } from "../src/main/agent-tools/codex-agent-tool-ipc";
import { buildCurrentTurnInputSourceTool } from "../src/main/agent-tools/current-turn-input-source-tool";
import { StdioJsonRpcTransport } from "../src/main/codex-app-server/stdio-transport";
import { WindowsCodexMcpRuntime } from "../src/main/codex-app-server/windows-codex-mcp-runtime";
import { buildCodexAgentToolsMcpConfig } from "../src/main/app-server/codex-thread-config";

const name = "pwragent_apps";
const tool = "get_current_turn_input_source";

function fixtureOwner() {
  const relay = process.env.PWRAGENT_TEST_MCP_STDIO_RELAY;
  assert(relay, "the fixture requires the built Rust stdio relay");
  const active = new Set<string>();
  let dispatches = 0;
  const router = new AgentToolRouter([buildCurrentTurnInputSourceTool(() => {
    dispatches++;
    return "desktop";
  })]);
  const server = new AgentToolMcpServer({
    verifyCodexThreadId: true, allowWindowsCodexIpc: true, codexRelayExecutable: () => relay,
    resolveCatalogs: () => [{ id: "app_management", router }],
    resolveCallContext: ({ threadId }) => threadId && active.has(threadId)
      ? { backend: "codex", threadId, turnId: "fixture-turn" }
      : undefined,
  });
  return {
    server, active, dispatches: () => dispatches,
    async register(runtime: WindowsCodexMcpRuntime, threadId?: string) {
      const registration = await server.registerCodexClient({ backend: "codex", threadId });
      const prepared = await bindCodexAgentToolRuntime({ config: buildCodexAgentToolsMcpConfig(registration) }, () => ({
        child: runtime.child, windows: runtime,
        isCurrent: () => runtime.child.exitCode === null && runtime.child.signalCode === null,
      })) as { config: { mcp_servers: Record<string, CodexAgentToolStdioConfig> } };
      return { registration, config: prepared.config };
    },
  };
}

function launch(helper: string, command: string, args: string[], env = process.env) {
  const runtime = new WindowsCodexMcpRuntime(command, args, env, helper);
  runtime.child.stderr.pipe(process.stderr, { end: false });
  return runtime;
}

async function readLine(stream: NodeJS.ReadableStream) {
  const reader = createInterface({ input: stream });
  try {
    return await Promise.race([
      once(reader, "line").then(([line]) => line as string),
      once(reader, "close").then(() => { throw new Error("process closed before its reply"); }),
    ]);
  } finally { reader.close(); }
}

async function relayFixture() {
  console.log("ready");
  const configs = JSON.parse(await readLine(process.stdin)) as Record<string, CodexAgentToolStdioConfig>;
  const entries = await Promise.all(Object.entries(configs).map(async ([threadId, config]) => {
    const client = new Client({ name: "windows-concurrent-fixture", version: "1" });
    await client.connect(new StdioClientTransport({ ...config, stderr: "inherit" }));
    return [threadId, client, config] as const;
  }));
  const call = (client: Client, threadId: string) => client.callTool({ name: tool, _meta: { threadId } });
  await Promise.all(entries.map(async ([threadId, client, config]) => {
    assert.deepEqual((await client.listTools()).tools.map(({ name }) => name), [tool]);
    assert.equal((await call(client, threadId === "one" ? "two" : "one")).isError, true);
    assert.equal((await call(client, threadId)).isError, true);
    const invalid = new Client({ name: "wrong-grant", version: "1" });
    await assert.rejects(invalid.connect(new StdioClientTransport({
      ...config, stderr: "ignore", env: { ...config.env, PWRAGENT_CODEX_MCP_GRANT: "x".repeat(43) },
    }), { timeout: 3000 }));
  }));
  console.log("idle");
  assert.equal(await readLine(process.stdin), "active");
  await Promise.all(entries.map(async ([threadId, client]) => {
    assert.deepEqual((await call(client, threadId)).structuredContent, { source: "desktop" });
  }));
  const [, first] = entries[0];
  const [secondThread, second] = entries[1];
  await first.close();
  assert.deepEqual((await call(second, secondThread)).structuredContent, { source: "desktop" });
  console.log("concurrent-ok");
}

async function stop(runtime: WindowsCodexMcpRuntime, root: number) {
  await runtime.close();
  const connection = createConnection(runtime.endpoint);
  try {
    await assert.rejects(once(connection, "connect"), { code: "ENOENT" });
  } finally { connection.destroy(); }
  assert.throws(() => process.kill(root, 0), { code: "ESRCH" });
}

async function proofOracle(helper: string) {
  const runtime = launch(helper, process.execPath, [__filename, "--relay-fixture"]);
  const owner = fixtureOwner();
  const nativeRoot = await runtime.ready;
  try {
    const startup = readLine(runtime.child.stdout);
    const configurations = await Promise.all(["one", "two"].map(async (threadId) => {
      const { config } = await owner.register(runtime, threadId);
      return [threadId, config.mcp_servers[name]] as const;
    }));
    assert.equal(await startup, "ready");
    const outside = spawn(configurations[0][1].command, configurations[0][1].args,
      { env: { ...process.env, ...configurations[0][1].env }, stdio: "ignore", windowsHide: true });
    const [outsideExit] = await once(outside, "exit");
    assert.notEqual(outsideExit, 0);
    const idle = readLine(runtime.child.stdout);
    runtime.child.stdin.write(JSON.stringify(Object.fromEntries(configurations)) + "\n");
    assert.equal(await idle, "idle");
    assert.equal(owner.dispatches(), 0);
    owner.active.add("one");
    owner.active.add("two");
    const result = readLine(runtime.child.stdout);
    runtime.child.stdin.write("active\n");
    assert.equal(await result, "concurrent-ok");
    assert.equal(owner.dispatches(), 3);
  } finally {
    await stop(runtime, nativeRoot);
    await owner.server.close();
  }
  console.log("Native concurrent streams, scoped grant and thread checks, independent teardown and job cleanup passed");
}

type WireEvent = { method: string; params: { threadId?: string; name?: string; status?: string; turn?: { status?: string } } };

function rpc(runtime: WindowsCodexMcpRuntime) {
  let id = 0;
  const signals = new EventEmitter();
  const history: WireEvent[] = [];
  const replies = new Map<number, (value: unknown) => void>();
  createInterface({ input: runtime.child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (message.id !== undefined) replies.get(message.id)?.(message);
    if (message.method) {
      const event = message as WireEvent;
      if (history.length >= 256) history.shift();
      history.push(event);
      signals.emit("event", event);
    }
  });
  const send = (message: object) => runtime.child.stdin.write(JSON.stringify(message) + "\n");
  return {
    notify: (method: string) => send({ method }),
    wait: (description: string, match: (event: WireEvent) => boolean) => new Promise<WireEvent>((resolve, reject) => {
      const existing = history.find(match);
      if (existing) { resolve(existing); return; }
      const onEvent = (event: WireEvent) => {
        if (!match(event)) return;
        clearTimeout(timeout);
        signals.off("event", onEvent);
        resolve(event);
      };
      const timeout = setTimeout(() => {
        signals.off("event", onEvent);
        reject(new Error(`Codex did not report ${description}`));
      }, 15_000);
      signals.on("event", onEvent);
    }),
    request: <T,>(method: string, params?: object): Promise<T> => {
      const requestId = ++id;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(requestId); reject(new Error(`Codex ${method} timed out`)); }, 18_000);
        replies.set(requestId, (value) => {
          clearTimeout(timer);
          replies.delete(requestId);
          const response = value as { result: T; error?: { message?: string } };
          if (response.error) reject(new Error(`Codex ${method}: ${response.error.message}`));
          else resolve(response.result);
        });
        send({ id: requestId, method, params });
      });
    },
  };
}

async function realCodex(helper: string, executable: string, cwd: string, sandbox: "read-only" | "workspace-write") {
  // Deterministically persist a real turn without using an account.
  let modelCalls = 0;
  const model = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain the disposable model request. */ }
    const id = `fixture-${++modelCalls}`;
    response.setHeader("Content-Type", "text/event-stream");
    for (const event of [
      { type: "response.created", response: { id } },
      { type: "response.output_item.done", item: {
        type: "message", role: "assistant", id: `msg-${id}`, content: [{ type: "output_text", text: "fixture complete" }],
      } },
      { type: "response.completed", response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end();
  });
  await new Promise<void>((resolve) => model.listen(0, "127.0.0.1", resolve));
  const address = model.address();
  assert(address && typeof address === "object");
  const codexHome = join(cwd, sandbox);
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), `model = "gpt-5.5"
model_provider = "fixture"
[model_providers.fixture]
name = "Disposable Windows test"
base_url = "http://127.0.0.1:${address.port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
[windows]
sandbox = "unelevated"
[features]
apps = false
plugins = false
hooks = false
`);
  const owner = fixtureOwner();
  const start = async () => {
    const transport = new StdioJsonRpcTransport({
      command: executable, args: ["--listen", "stdio://"],
      env: { ...process.env, CODEX_HOME: codexHome, OPENAI_API_KEY: undefined },
      windowsCodexMcpEnabled: () => true, windowsCodexMcpRelay: () => helper,
    });
    await transport.connect();
    const runtime = transport.ownedProcess()?.windows;
    assert(runtime, "the real native executable must use the production Windows launcher");
    const api = rpc(runtime);
    const nativeRoot = await runtime.ready;
    await api.request("initialize", { clientInfo: { name: "pwragent-windows-owner", version: "1" }, capabilities: { experimentalApi: true } });
    api.notify("initialized");
    return { runtime, nativeRoot, api, transport };
  };
  const inventory = async (api: ReturnType<typeof rpc>, threadId: string) => {
    const result = await api.request<{ data: Array<{ name: string; tools: Record<string, unknown>; toolsError: string | null }> }>("mcpServerStatus/list", {
      threadId, detail: "toolsAndAuthOnly", limit: 100,
    });
    const server = result.data.find((row) => row.name === name);
    assert(server && Object.hasOwn(server.tools, tool), `Inspector omitted the owner tool (${server?.toolsError ?? "unknown"})`);
  };
  const ready = async (api: ReturnType<typeof rpc>, threadId: string) => {
    const event = await api.wait("thread MCP startup", (entry) => entry.method === "mcpServer/startupStatus/updated"
      && entry.params.name === name && entry.params.threadId === threadId && entry.params.status !== "starting");
    assert.equal(event.params.status, "ready");
  };
  let generation: Awaited<ReturnType<typeof start>> | undefined;
  try {
    generation = await start();
    const original = await owner.register(generation.runtime);
    const { api } = generation;
    const { thread } = await api.request<{ thread: { id: string } }>("thread/start", {
      cwd, model: "gpt-5.5", modelProvider: "fixture", approvalPolicy: "never", sandbox, config: original.config,
    });
    original.registration.bindThread(thread.id);
    await ready(api, thread.id);
    await inventory(api, thread.id);
    const resolved = await api.request<{ config: { windows?: { sandbox?: string } } }>("config/read", { cwd, includeLayers: false });
    assert.equal(resolved.config.windows?.sandbox, "unelevated");
    const command = await api.request<{ exitCode: number; stdout: string; stderr: string }>("command/exec", {
      command: [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), "/d", "/c", "echo", "verified-sandbox-child"],
      cwd,
      timeoutMs: 10_000,
      sandboxPolicy: sandbox === "read-only"
        ? { type: "readOnly", networkAccess: false }
        : { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
    });
    assert.equal(command.exitCode, 0, command.stderr);
    assert.match(command.stdout, /verified-sandbox-child/u);
    const idle = await api.request<{ isError: boolean }>("mcpServer/tool/call", { threadId: thread.id, server: name, tool, arguments: {} });
    assert.equal(idle.isError, true);
    await api.request("turn/start", { threadId: thread.id, input: [{ type: "text", text: "Save one fixture turn.", text_elements: [] }] });
    const turn = await api.wait("turn completion", (event) => event.method === "turn/completed" && event.params.threadId === thread.id);
    assert.equal(turn.params.turn?.status, "completed");
    await api.request("config/mcpServer/reload");
    await inventory(api, thread.id);
    const fork = await owner.register(generation.runtime);
    const forked = await api.request<{ thread: { id: string } }>("thread/fork", {
      threadId: thread.id, cwd, approvalPolicy: "never", sandbox, config: fork.config,
    });
    assert.notEqual(forked.thread.id, thread.id);
    fork.registration.bindThread(forked.thread.id);
    await ready(api, forked.thread.id);
    await Promise.all([inventory(api, thread.id), inventory(api, forked.thread.id)]);
    const retiredEndpoint = generation.runtime.endpoint;
    await generation.transport.close();
    await stop(generation.runtime, generation.nativeRoot);
    generation = undefined;
    generation = await start();
    assert.notEqual(generation.runtime.endpoint, retiredEndpoint);
    const resume = await owner.register(generation.runtime, thread.id);
    await generation.api.request("thread/resume", { threadId: thread.id, cwd, sandbox, approvalPolicy: "never", config: resume.config });
    await ready(generation.api, thread.id);
    await inventory(generation.api, thread.id);
    assert(modelCalls > 0);
    console.log(`Real Windows Codex ${sandbox}: inspector, sandbox child, reload, fork, restart, and cleanup passed`);
  } finally {
    if (generation) {
      await generation.transport.close();
      await stop(generation.runtime, generation.nativeRoot);
    }
    await owner.server.close();
    await new Promise<void>((resolve) => model.close(() => resolve()));
  }
}

async function main(helper: string, codex?: string) {
  const inactive = new AgentToolMcpServer({ resolveCatalogs: () => [], resolveCallContext: () => undefined });
  try {
    await assert.rejects(inactive.registerCodexClient({ backend: "codex" }), /macOS and Linux/u);
  } finally { await inactive.close(); }
  const cwd = await mkdtemp(join(tmpdir(), "pwa-win-codex-"));
  try {
    await proofOracle(helper);
    if (codex) {
      await realCodex(helper, codex, cwd, "read-only");
      await realCodex(helper, codex, cwd, "workspace-write");
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

const args = process.argv.slice(2);
const timer = setTimeout(() => { console.error("Windows Codex owner test timed out"); process.exit(1); }, 120_000);
void (args[0] === "--relay-fixture" ? relayFixture() : main(args[0], args[1])).then(
  () => clearTimeout(timer),
  (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1; },
);
