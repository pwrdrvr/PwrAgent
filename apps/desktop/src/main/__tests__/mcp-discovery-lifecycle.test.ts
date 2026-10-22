import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpConnectionGatewayService } from "../mcp-connections/mcp-connection-gateway-service";
import { McpDiscovery, mcpDiscoveryContext } from "../mcp-connections/mcp-discovery";
import { McpConnectionRegistry } from "../mcp-connections/mcp-connection-registry";
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => logs }));

const services: McpConnectionGatewayService[] = [];
const directories: string[] = [];
const secret = "fixture-access-token-never-log";
const grant = { connectionId: "pwrsnap", threadId: JSON.stringify(["gateway", "codex", "fixture-thread"]) };

type Internals = {
  grants: Map<string, typeof grant>;
  upstreamStarts: Map<string, unknown>;
  upstreamSessions: Map<string, unknown>;
  dispatchBridgeOperation: (token: string, bridgeGrant: typeof grant, operation: string, params: unknown, signal: AbortSignal, deadlineAt?: number) => Promise<unknown>;
};

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-mcp-discovery-"));
  directories.push(directory);
  const registry = new McpConnectionRegistry({ configPath: path.join(directory, "config.toml") });
  let initializeMs = 0;
  let listMs = 0;
  let failure: "http503" | "http504" | "reset" | "sdk" | undefined;
  let pageCount = 1;
  const posts: Array<{ method: string; signal?: AbortSignal | null; at: number }> = [];
  const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { cursor?: string } };
    posts.push({ method: request.method, signal: init?.signal, at: Date.now() });
    if (request.method.startsWith("notifications/")) return new Response(null, { status: 202 });
    const delayMs = request.method === "initialize" ? initializeMs : listMs;
    if (delayMs) await new Promise<void>((resolve, reject) => {
      const abort = (): void => { clearTimeout(timer); reject(init?.signal?.reason); };
      const timer = setTimeout(() => { init?.signal?.removeEventListener("abort", abort); resolve(); }, delayMs);
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
    if (request.method === "initialize" && failure) {
      if (failure === "http503" || failure === "http504") return new Response(`private body ${secret}`, { status: failure === "http503" ? 503 : 504 });
      if (failure === "reset") throw new TypeError(`fetch failed ${secret}`, { cause: Object.assign(new Error("private cause"), { code: "ECONNRESET" }) });
      return Response.json({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: `private SDK error ${secret}` } });
    }
    const page = Number(request.params?.cursor ?? 1);
    const result = request.method === "initialize"
      ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } }
      : request.method === "tools/call" ? { content: [{ type: "text", text: "fixture result" }] }
      : { tools: [{ name: `lookup_${page}`, inputSchema: { type: "object" } }], ...(page < pageCount ? { nextCursor: String(page + 1) } : {}) };
    return Response.json({ jsonrpc: "2.0", id: request.id, result });
  });
  let storedCredential: string | undefined;
  const credential = JSON.stringify({ tokens: { access_token: secret, token_type: "bearer" } });
  const service = new McpConnectionGatewayService({
    registry, leaseManager: null, readGatewaySelection: async () => ["pwrsnap"], fetchFn,
    settings: {
      resolvePwrSnapMcpCredential: async () => credential,
      resolvePwrGitMcpCredential: async () => undefined,
      resolveMcpConnectionCredentials: async () => storedCredential,
      clearPwrSnapMcpCredential: async () => undefined,
      clearPwrGitMcpCredential: async () => undefined,
      clearMcpConnectionCredentials: async () => { storedCredential = undefined; },
      savePwrSnapMcpCredential: async () => undefined,
      saveMcpConnectionCredentials: async (value: string) => { storedCredential = value; },
    },
  });
  services.push(service);
  const internals = service as unknown as Internals;
  internals.grants.set("fixture", grant);
  return {
    service, internals, posts,
    configure(options: { initializeMs?: number; listMs?: number; failure?: typeof failure; pageCount?: number }) {
      initializeMs = options.initializeMs ?? 0;
      listMs = options.listMs ?? 0;
      failure = options.failure;
      pageCount = options.pageCount ?? 1;
    },
    run(operation = "gateway/tools/list", signal = new AbortController().signal, deadlineAt = Date.now() + 60_000, params: unknown = {}) {
      return internals.dispatchBridgeOperation("fixture", grant, operation, params, signal, deadlineAt);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(services.splice(0).map(async (service) => await service.close()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("MCP discovery lifecycle with the real SDK and a fake HTTP endpoint", () => {
  it("answers native startup after a 35-second initialize with accurate capabilities", async () => {
    const f = fixture();
    f.configure({ initializeMs: 35_000 });
    const startup = f.run("describe");
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(startup).resolves.toEqual({ tools: true, resources: false, prompts: false });
    expect(f.posts.some((post) => post.method === "tools/list")).toBe(false);
    await expect(f.run()).resolves.toMatchObject([{ toolName: "lookup_1" }]);
    expect(f.posts.filter((post) => post.method === "initialize")).toHaveLength(1);
  });

  it("includes a 10-second initialize in the deadline for a 55-second list", async () => {
    const f = fixture();
    f.configure({ initializeMs: 10_000, listMs: 55_000 });
    const result = f.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ data: { kind: "deadline", phase: "tools/list", page: 1, elapsedMs: 60_000 } });
    expect(f.posts.find((post) => post.method === "tools/list")?.signal?.aborted).toBe(true);
    const status = (await f.service.listConnections()).find((connection) => connection.id === "pwrsnap");
    expect(status).toMatchObject({ configured: true, state: "ready", discovery: { state: "failed", lastFailure: { message: expect.stringContaining("tools/list") } } });
    f.configure({});
    await expect(f.run()).resolves.toMatchObject([{ toolName: "lookup_1" }]);
    expect((await f.service.listConnections()).find((connection) => connection.id === "pwrsnap")?.discovery)
      .toMatchObject({ state: "ready", lastSuccessAt: expect.any(Number), lastFailure: expect.any(Object) });
  });

  it("shares initialization while isolating one cancelled waiter", async () => {
    const f = fixture();
    f.configure({ initializeMs: 35_000 });
    const controller = new AbortController();
    const first = f.run("gateway/tools/list", controller.signal).catch((error: unknown) => error);
    const sibling = f.run();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await first).toMatchObject({ data: { kind: "cancelled", phase: "initialize" } });
    expect(f.posts.find((post) => post.method === "initialize")?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(sibling).resolves.toMatchObject([{ toolName: "lookup_1" }]);
    expect(f.posts.filter((post) => post.method === "initialize")).toHaveLength(1);
  });

  it.each(["cancel", "deadline"])("cleans an abandoned initialize after %s and retries independently", async (mode) => {
    const f = fixture();
    f.configure({ initializeMs: 1_000_000 });
    const controller = new AbortController();
    const result = f.run("gateway/tools/list", controller.signal).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "cancel") controller.abort();
    else await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ data: { kind: mode === "cancel" ? "cancelled" : "deadline", phase: "initialize" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.posts.find((post) => post.method === "initialize")?.signal?.aborted).toBe(true);
    expect(f.internals.upstreamStarts.size).toBe(0);
    expect(f.internals.upstreamSessions.size).toBe(0);
    f.configure({});
    await expect(f.run()).resolves.toMatchObject([{ toolName: "lookup_1" }]);
    expect(f.posts.filter((post) => post.method === "initialize")).toHaveLength(2);
  });

  it("isolates later tool POSTs from inherited registration context and cancelled siblings", async () => {
    const f = fixture();
    await f.run();
    const abandoned = new AbortController();
    abandoned.abort();
    const registration = new McpDiscovery("pwrsnap", Date.now() + 60_000, abandoned.signal);
    const params = { name: "lookup_1", arguments: {} };
    try {
      await expect(mcpDiscoveryContext.run(registration, async () => await f.run("tools/call", undefined, undefined, params)))
        .resolves.toMatchObject({ content: [{ text: "fixture result" }] });
    } finally {
      registration.close();
    }
    f.configure({ listMs: 1_000_000 });
    const controller = new AbortController();
    const waiting = f.run("tools/call", controller.signal, undefined, params).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    const post = f.posts.filter((post) => post.method === "tools/call").at(-1);
    f.configure({});
    await expect(f.run("tools/call", undefined, undefined, params)).resolves.toMatchObject({ content: [{ text: "fixture result" }] });
    controller.abort();
    expect(await waiting).toBeInstanceOf(Error);
    expect(post?.signal?.aborted).toBe(true);
    expect(f.internals.upstreamSessions.size).toBe(1);
    await expect(f.run("tools/call", undefined, undefined, params)).resolves.toMatchObject({ content: [{ text: "fixture result" }] });
  });

  it("keeps one deadline across initialization and paginated listing", async () => {
    const f = fixture();
    f.configure({ initializeMs: 10_000, listMs: 20_000, pageCount: 4 });
    const result = f.run().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toMatchObject({ data: { kind: "deadline", phase: "tools/list", page: 3 } });
    expect(f.posts.filter((post) => post.method === "tools/list")).toHaveLength(3);
  });

  it.each([
    ["http503", { kind: "upstream_http", status: 503, errorName: "StreamableHTTPError" }],
    ["http504", { kind: "upstream_http", status: 504 }],
    ["sdk", { kind: "sdk_timeout", code: -32001 }],
    ["reset", { kind: "upstream_network", networkCode: "ECONNRESET" }],
  ] as const)("returns sanitized, distinct diagnostics for %s", async (failure, diagnostic) => {
    const f = fixture();
    f.configure({ failure });
    const error = await f.run().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ data: { ...diagnostic, connectionId: "pwrsnap", phase: "initialize", discoveryId: expect.any(String) } });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(logs.info.mock.calls)).not.toContain(secret);
    expect(f.internals.upstreamStarts.size).toBe(0);
  });
});
