import { sandboxerStub } from "./helpers/sandboxer-stub";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type ClientCapabilities,
  type ElicitRequestParams,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
import { ConnectionRpcClient, type McpBridgeEvent } from "../mcp-connections/mcp-connection-rpc-client";
import type { ElicitationRoute } from "../mcp-connections/mcp-elicitation-relay";
import type { McpGatewayTool } from "../mcp-connections/mcp-gateway-catalog";
import { McpStdioSecretVault } from "../mcp-connections/mcp-stdio-secret-vault";
import { SandboxerConnection } from "../mcp-connections/sandboxer-connection";
import type { ThreadRootDirectory } from "../mcp-connections/mcp-upstream-roots";

/*
 * MCP roots and URL elicitation, end to end through the gateway, against a
 * local command that asks for its roots, sends a sign-in link mid-call,
 * fails a call with `-32042`, and announces that a link's flow finished. The
 * server logs every message it saw, so a test can assert what reached it.
 */
const FAKE_SERVER = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(entry) + "\n");
const waiting = new Map();
let next = 1;
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
function result(id, body) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(body) }] } });
}
function ask(callId, kind, method, params) {
  const id = "fixture-" + next++;
  waiting.set(id, { callId, kind });
  send({ jsonrpc: "2.0", id, method, params });
}
function handle(message) {
  if (message.method === undefined) {
    const asked = waiting.get(message.id);
    waiting.delete(message.id);
    log({ event: "answer", kind: asked && asked.kind, result: message.result, error: message.error });
    if (asked) result(asked.callId, { result: message.result || null, error: message.error || null });
    return;
  }
  if (message.id === undefined) {
    log({ event: "notification", method: message.method });
    return;
  }
  if (message.method === "initialize") {
    log({ event: "initialize", capabilities: message.params.capabilities });
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fixture-files", version: "1.0.0" },
    } });
  } else if (message.method === "tools/list") {
    const tool = (name) => ({ name, inputSchema: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } } } });
    send({ jsonrpc: "2.0", id: message.id, result: { tools: ["roots", "link", "needs_signin", "complete"].map(tool) } });
  } else if (message.method === "tools/call") {
    const args = message.params.arguments || {};
    log({ event: "call", name: message.params.name });
    if (message.params.name === "roots") {
      ask(message.id, "roots", "roots/list", {});
    } else if (message.params.name === "link") {
      ask(message.id, "link", "elicitation/create", {
        mode: "url",
        message: "Sign in to Fixture Files.",
        elicitationId: args.id || "link-1",
        url: args.url,
      });
    } else if (message.params.name === "needs_signin") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32042, message: "Sign-in required", data: { elicitations: [
        { mode: "url", elicitationId: "signin-1", url: "https://auth.fixture.test/start?state=s1", message: "Sign in to Fixture Files." },
      ] } } });
    } else if (message.params.name === "complete") {
      send({ jsonrpc: "2.0", method: "notifications/elicitation/complete", params: { elicitationId: args.id } });
      result(message.id, { completed: args.id });
    }
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "no such method" } });
  }
}
`;

type LogEntry = {
  event: "initialize" | "call" | "answer" | "notification";
  capabilities?: Record<string, unknown>;
  kind?: string;
  name?: string;
  method?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

type Fixture = { root: string; binDir: string; log: string; dirA: string; dirB: string };

const services: McpConnectionGatewayService[] = [];
const disposals: Array<() => Promise<void>> = [];
const temporaryDirectories: string[] = [];

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-roots-"));
  temporaryDirectories.push(root);
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "fixture-files-mcp"), FAKE_SERVER, { mode: 0o755 });
  const dirA = path.join(root, "checkout a");
  const dirB = path.join(root, "worktree-b");
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB);
  return { root, binDir, log: path.join(root, "server.jsonl"), dirA, dirB };
}

function readLog(fixture: Fixture): LogEntry[] {
  if (!fs.existsSync(fixture.log)) return [];
  return fs.readFileSync(fixture.log, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

function rootsChanged(fixture: Fixture): number {
  return readLog(fixture)
    .filter((entry) => entry.event === "notification" && entry.method === "notifications/roots/list_changed")
    .length;
}

async function createService(
  fixture: Fixture,
  resolveThreadRoots?: (scope: { backend: string; threadId: string }) => Promise<ThreadRootDirectory[]>,
) {
  const selection = { ids: [] as string[] };
  const service = new McpConnectionGatewayService({
    sandboxer: sandboxerStub(),
    bridgeEntryPath: "/test/mcp-connection-bridge.js",
    gatewayEnabled: () => true,
    leaseManager: null,
    readGatewaySelection: async () => selection.ids,
    ...(resolveThreadRoots ? { resolveThreadRoots } : {}),
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
    displayName: "Fixture Files",
    stdio: {
      command: "fixture-files-mcp",
      args: [],
      cwd: fixture.root,
      env: [{ name: "FIXTURE_LOG", secret: false, value: fixture.log }],
    },
  });
  selection.ids.push(connection.id);
  return { service, connectionId: connection.id };
}

function rpcFor(registration: { server: { env: Record<string, string> } }): ConnectionRpcClient {
  const env = registration.server.env;
  return new ConnectionRpcClient(env.PWRAGENT_MCP_CONNECTION_SOCKET!, env.PWRAGENT_MCP_CONNECTION_TOKEN!);
}

type ToolReply = { result: Record<string, unknown> | null; error: { code: number; message: string } | null };

async function callTool(
  rpc: ConnectionRpcClient,
  name: string,
  args: Record<string, unknown> = {},
  options: { onElicit?: ElicitationRoute; links?: boolean; signal?: AbortSignal } = {},
): Promise<ToolReply> {
  const reply = await rpc.request(
    "tools/call",
    { name, arguments: args },
    options.signal,
    undefined,
    undefined,
    undefined,
    options.onElicit,
    undefined,
    options.links ? { urlElicitation: true } : undefined,
  ) as { content: Array<{ text: string }> };
  return JSON.parse(reply.content[0]!.text) as ToolReply;
}

async function readRoots(rpc: ConnectionRpcClient): Promise<unknown> {
  return (await callTool(rpc, "roots")).result?.roots;
}

function rootUri(directory: string): string {
  return pathToFileURL(directory).href;
}

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("MCP roots on managed local commands", () => {
  it("declares roots and both elicitation modes on a thread session only", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture, async () => []);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));

    await readRoots(rpc);
    await service.listConnectionTools({ connectionId, refresh: true });

    const capabilities = readLog(fixture)
      .filter((entry) => entry.event === "initialize")
      .map((entry) => entry.capabilities);
    // The thread's session, then the Settings listing.
    expect(capabilities).toEqual([
      { elicitation: { form: {}, url: {} }, roots: { listChanged: true } },
      {},
    ]);
  });

  it("answers with the thread's existing, absolute, distinct directories in order", async () => {
    const fixture = makeFixture();
    const resolver = vi.fn(async () => [
      { path: fixture.dirA },
      { path: fixture.dirA, name: "Checkout A" },
      { path: "relative/dir", name: "Relative" },
      { path: fixture.dirB, name: "Worktree B" },
    ]);
    const { service, connectionId } = await createService(fixture, resolver);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));

    const expected = [
      { uri: rootUri(fixture.dirA), name: "Checkout A" },
      { uri: rootUri(fixture.dirB), name: "Worktree B" },
    ];
    await waitFor(async () => JSON.stringify(await readRoots(rpc)) === JSON.stringify(expected), "the thread's roots");
    expect(resolver).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-a" });
    // `checkout a` has a space; the URI encodes it.
    expect(expected[0]!.uri).toContain("checkout%20a");
  });

  it("tells the session its roots changed, once per change, and only for its own thread", async () => {
    const fixture = makeFixture();
    const directories = new Map<string, ThreadRootDirectory[]>([
      ["thread-a", [{ path: fixture.dirA }]],
      ["thread-b", [{ path: fixture.dirB }]],
    ]);
    const { service, connectionId } = await createService(fixture, async (scope) => directories.get(scope.threadId) ?? []);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));
    await waitFor(async () => JSON.stringify(await readRoots(rpc)) === JSON.stringify([{ uri: rootUri(fixture.dirA) }]), "first roots");

    directories.set("thread-a", [{ path: fixture.dirA }, { path: fixture.dirB }]);
    service.noteThreadDirectoriesChanged("codex", ["thread-a"]);
    await waitFor(() => rootsChanged(fixture) === 1, "a roots change notification");

    // Unread, the same change is not announced twice.
    service.noteThreadDirectoriesChanged("codex", ["thread-a"]);
    // Another thread, and the same thread id on another backend, are not this session's.
    directories.set("thread-b", []);
    service.noteThreadDirectoriesChanged("codex", ["thread-b"]);
    service.noteThreadDirectoriesChanged("claude", ["thread-a"]);
    expect(await readRoots(rpc)).toEqual([{ uri: rootUri(fixture.dirA) }, { uri: rootUri(fixture.dirB) }]);
    expect(rootsChanged(fixture)).toBe(1);

    directories.set("thread-a", []);
    service.noteThreadDirectoriesChanged("codex", ["thread-a"]);
    await waitFor(() => rootsChanged(fixture) === 2, "a second roots change notification");
    expect(await readRoots(rpc)).toEqual([]);
  });

  it("answers no roots before the grant names a thread, then announces them on bind", async () => {
    const fixture = makeFixture();
    const resolver = vi.fn(async () => [{ path: fixture.dirA }]);
    const { service, connectionId } = await createService(fixture, resolver);
    const registration = await service.registerBridge(connectionId, undefined, undefined, "codex");
    const rpc = rpcFor(registration);

    expect(await readRoots(rpc)).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();

    registration.bindThread("thread-new");
    await waitFor(() => rootsChanged(fixture) === 1, "roots announced on bind");
    expect(await readRoots(rpc)).toEqual([{ uri: rootUri(fixture.dirA) }]);
    expect(resolver).toHaveBeenCalledWith({ backend: "codex", threadId: "thread-new" });
  });

  it("gives a bare thread id with no backend no roots", async () => {
    const fixture = makeFixture();
    const resolver = vi.fn(async () => [{ path: fixture.dirA }]);
    const { service, connectionId } = await createService(fixture, resolver);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a"));

    expect(await readRoots(rpc)).toEqual([]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("reads a gateway scope's backend and thread from the scope itself", async () => {
    const fixture = makeFixture();
    const resolver = vi.fn(async () => [{ path: fixture.dirB }]);
    const { service, connectionId } = await createService(fixture, resolver);
    const rpc = rpcFor(await service.registerBridge(connectionId, JSON.stringify(["gateway", "claude", "thread-g"])));

    await waitFor(async () => JSON.stringify(await readRoots(rpc)) === JSON.stringify([{ uri: rootUri(fixture.dirB) }]), "gateway roots");
    expect(resolver).toHaveBeenCalledWith({ backend: "claude", threadId: "thread-g" });
  });
});

describe.skipIf(process.platform === "win32")("MCP links on managed connections", () => {
  it("routes a link to its one call verbatim and answers accept without content", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));
    const seen: ElicitRequestParams[] = [];

    const reply = await callTool(rpc, "link", { url: "https://auth.fixture.test/start?state=s1" }, {
      links: true,
      onElicit: async (params) => {
        seen.push(params);
        return { action: "accept", content: { smuggled: true }, _meta: { "client/kept": 1 } };
      },
    });

    expect(seen).toEqual([{
      mode: "url",
      message: "Sign in to Fixture Files.",
      elicitationId: "link-1",
      url: "https://auth.fixture.test/start?state=s1",
    }]);
    expect(reply).toEqual({ result: { action: "accept", _meta: { "client/kept": 1 } }, error: null });
  });

  it.each(["decline", "cancel"] as const)("returns %s for a link", async (action) => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));

    const reply = await callTool(rpc, "link", { url: "https://auth.fixture.test/" }, {
      links: true,
      onElicit: async () => ({ action }),
    });

    expect(reply.result).toEqual({ action });
  });

  it("fails closed when the caller can show forms but not links", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));
    const onElicit = vi.fn(async () => ({ action: "accept" }));

    const reply = await callTool(rpc, "link", { url: "https://auth.fixture.test/" }, { onElicit });

    expect(onElicit).not.toHaveBeenCalled();
    expect(reply.error?.code).toBe(-32601);
    expect(reply.error?.message).toContain("cannot show links");
  });

  it.each([
    ["plain http to another host", "http://auth.fixture.test/start"],
    ["a user name and password", "https://name:secret@auth.fixture.test/"],
    ["a non-web scheme", "file:///etc/passwd"],
    ["no address", "not a url"],
  ])("refuses a link with %s before any person sees it", async (_label, url) => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));
    const onElicit = vi.fn(async () => ({ action: "accept" }));

    const reply = await callTool(rpc, "link", { url }, { links: true, onElicit });

    expect(onElicit).not.toHaveBeenCalled();
    expect(reply.error?.code).toBe(-32602);
  });

  it("lets a local command send its own http page on this machine", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));

    const reply = await callTool(rpc, "link", { url: "http://127.0.0.1:43123/sign-in" }, {
      links: true,
      onElicit: async () => ({ action: "accept" }),
    });

    expect(reply.result).toEqual({ action: "accept" });
  });

  it("answers cancel when the caller leaves while the link is shown", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const rpc = rpcFor(await service.registerBridge(connectionId, "thread-a", undefined, "codex"));
    const controller = new AbortController();
    let shown = false;

    const call = callTool(rpc, "link", { url: "https://auth.fixture.test/" }, {
      links: true,
      signal: controller.signal,
      onElicit: async () => {
        shown = true;
        return await new Promise(() => undefined);
      },
    });
    await waitFor(() => shown, "the link to be shown");
    controller.abort();
    await expect(call).rejects.toThrow();

    await waitFor(() => readLog(fixture).some((entry) => entry.event === "answer"), "the server's answer");
    expect(readLog(fixture).find((entry) => entry.event === "answer")?.result).toEqual({ action: "cancel" });
  });

  it("tells the native bridge a link it opened has finished, once, and nothing else", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const registration = await service.registerBridge(connectionId, "thread-a", undefined, "codex");
    const rpc = rpcFor(registration);
    const events: McpBridgeEvent[] = [];
    await rpcFor(registration).attach(5_000, (event) => events.push(event));

    await callTool(rpc, "link", { url: "https://auth.fixture.test/", id: "opened" }, {
      links: true, onElicit: async () => ({ action: "accept" }),
    });
    await callTool(rpc, "link", { url: "https://auth.fixture.test/", id: "declined" }, {
      links: true, onElicit: async () => ({ action: "decline" }),
    });
    await callTool(rpc, "complete", { id: "declined" });
    await callTool(rpc, "complete", { id: "unknown" });
    await callTool(rpc, "complete", { id: "opened" });
    await callTool(rpc, "complete", { id: "opened" });

    await waitFor(() => events.length > 0, "the completion event");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toEqual([
      { method: "notifications/elicitation/complete", params: { elicitationId: "opened" } },
    ]);
  });

  it("passes a native call's -32042 through unchanged, then forwards its links' completion", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const registration = await service.registerBridge(connectionId, "thread-a", undefined, "codex");
    const rpc = rpcFor(registration);
    const events: McpBridgeEvent[] = [];
    await rpcFor(registration).attach(5_000, (event) => events.push(event));
    const onElicit = vi.fn(async () => ({ action: "accept" }));

    const error = await callTool(rpc, "needs_signin", {}, { links: true, onElicit }).catch((caught: unknown) => caught);

    expect(onElicit).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32042);
    expect((error as McpError).data).toEqual({ elicitations: [
      { mode: "url", elicitationId: "signin-1", url: "https://auth.fixture.test/start?state=s1", message: "Sign in to Fixture Files." },
    ] });

    // The host may open the listed link itself; it is told when it finishes.
    await callTool(rpc, "complete", { id: "signin-1" });
    await waitFor(() => events.length > 0, "the completion event");
    expect(events).toEqual([
      { method: "notifications/elicitation/complete", params: { elicitationId: "signin-1" } },
    ]);
  });

  it("shows a gateway call's -32042 link to the person and never retries the call", async () => {
    const fixture = makeFixture();
    const { service, connectionId } = await createService(fixture);
    const scopeKey = JSON.stringify(["gateway", "codex", "thread-a"]);
    const signal = new AbortController().signal;
    const tools = await service.requestGatewayToolOperation({
      connectionId, scopeKey, operation: "gateway/tools/list", signal,
    }) as McpGatewayTool[];
    const tool = tools.find((entry) => entry.toolName === "needs_signin")!;
    const seen: ElicitRequestParams[] = [];

    const error = await service.requestGatewayToolOperation({
      connectionId, scopeKey, operation: "gateway/tools/call", signal,
      invocation: { ...tool, arguments: {} },
      elicitUrl: true,
      elicit: async (params) => {
        seen.push(params);
        return { action: "accept" };
      },
    }).catch((caught: unknown) => caught);

    expect(seen).toEqual([{
      mode: "url",
      elicitationId: "signin-1",
      url: "https://auth.fixture.test/start?state=s1",
      message: "Sign in to Fixture Files.",
    }]);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(-32042);
    expect((error as McpError).message).toContain("they opened it");
    expect(readLog(fixture).filter((entry) => entry.event === "call")).toHaveLength(1);
  });
});

describe("MCP links and roots on a connection that is not a local command", () => {
  function sandboxerFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-links-remote-"));
    temporaryDirectories.push(root);
    const registry = new McpConnectionRegistry({ configPath: path.join(root, "config.toml") });
    registry.setSandboxerTransport("local_cli");
    registry.setEnabled("builtin:sandboxer", true);
    const sandboxer = new SandboxerConnection(async () => '{"signedIn":true,"apiReachable":true}');
    const declared: Array<ClientCapabilities | undefined> = [];
    const servers: Server[] = [];
    vi.spyOn(sandboxer, "createTransport").mockImplementation(() => {
      const [client, remote] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-remote", version: "1" }, { capabilities: { tools: {} } });
      server.oninitialized = () => declared.push(server.getClientCapabilities());
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: "link", inputSchema: { type: "object" as const, properties: { url: { type: "string" } } } },
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        try {
          const answer = await server.elicitInput({
            mode: "url",
            message: "Sign in to Fixture Remote.",
            elicitationId: "remote-1",
            url: String(request.params.arguments?.url),
          });
          return { content: [{ type: "text", text: JSON.stringify({ answer }) }] };
        } catch (error) {
          return { content: [{ type: "text", text: JSON.stringify({ error: (error as McpError).code }) }] };
        }
      });
      void server.connect(remote);
      servers.push(server);
      return client;
    });
    const read = vi.fn(async () => undefined);
    const service = new McpConnectionGatewayService({
      registry, sandboxer, leaseManager: null,
      readGatewaySelection: async () => ["builtin:sandboxer"],
      resolveThreadRoots: async () => [{ path: root }],
      settings: {
        resolveMcpConnectionCredentials: read,
        resolvePwrSnapMcpCredential: read,
        resolvePwrGitMcpCredential: read,
        clearMcpConnectionCredentials: vi.fn(async () => undefined),
        clearPwrSnapMcpCredential: vi.fn(async () => undefined),
        clearPwrGitMcpCredential: vi.fn(async () => undefined),
        saveMcpConnectionCredentials: vi.fn(async () => undefined),
        savePwrSnapMcpCredential: vi.fn(async () => undefined),
      },
    });
    services.push(service);
    disposals.push(async () => { await Promise.all(servers.map(async (server) => await server.close())); });
    const scopeKey = JSON.stringify(["gateway", "codex", "thread-r"]);
    const signal = new AbortController().signal;
    const call = async (url: string, elicit: ElicitationRoute) => {
      const tools = await service.requestGatewayToolOperation({
        connectionId: "builtin:sandboxer", scopeKey, operation: "gateway/tools/list", signal,
      }) as McpGatewayTool[];
      const reply = await service.requestGatewayToolOperation({
        connectionId: "builtin:sandboxer", scopeKey, operation: "gateway/tools/call", signal,
        invocation: { ...tools[0]!, arguments: { url } }, elicitUrl: true, elicit,
      }) as { content: Array<{ text: string }> };
      return JSON.parse(reply.content[0]!.text) as { answer?: unknown; error?: number };
    };
    return { declared, call };
  }

  it("declares links but never roots, and refuses a remote server's http link to this machine", async () => {
    const f = sandboxerFixture();
    const elicit = vi.fn(async () => ({ action: "accept" }));

    expect(await f.call("https://auth.fixture.test/remote", elicit)).toEqual({ answer: { action: "accept" } });
    expect(await f.call("http://127.0.0.1:8080/admin", elicit)).toEqual({ error: -32602 });

    expect(elicit).toHaveBeenCalledOnce();
    expect(f.declared).toEqual([{ elicitation: { form: {}, url: {} } }]);
  });
});
