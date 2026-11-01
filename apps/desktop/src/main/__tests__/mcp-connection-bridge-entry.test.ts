import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema, ToolListChangedNotificationSchema, PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema, type ElicitRequestParams, type InitializeResult } from "@modelcontextprotocol/sdk/types.js";
import { McpInitializationTransport } from "../mcp-connections/mcp-initialization-transport";
import type { McpBridgeEvent } from "../mcp-connections/mcp-connection-rpc-client";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ElicitationRoute } from "../mcp-connections/mcp-elicitation-relay";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  attach: vi.fn(async () => true),
  request: vi.fn(),
  transport: undefined as Transport | undefined,
  event: undefined as ((event: McpBridgeEvent) => void) | undefined,
  initialization: undefined as InitializeResult | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function () { return bridge.transport; }),
}));
vi.mock("../mcp-connections/mcp-connection-rpc-client.js", () => ({
  ConnectionRpcClient: vi.fn(function () { return { attach: bridge.attach, request: bridge.request }; }),
}));

const clients: Client[] = [];
let now: number;

beforeEach(() => {
  vi.resetModules();
  bridge.request.mockReset();
  bridge.attach.mockReset();
  bridge.attach.mockImplementation(async (_timeout?: number, onEvent?: (event: McpBridgeEvent) => void) => { bridge.event = onEvent; return true; });
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(process, "exit").mockImplementation(() => { throw new Error("Unexpected native bridge exit."); });
  vi.stubEnv("PWRAGENT_MCP_CONNECTION_SOCKET", "/tmp/pwragent-native-catalog-fixture.sock");
  vi.stubEnv("PWRAGENT_MCP_CONNECTION_TOKEN", "native-catalog-fixture");
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => await client.close()));
  await bridge.transport?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function openBridge(
  client = new Client({ name: "native-catalog-fixture", version: "1.0.0" }),
): Promise<Client> {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  bridge.transport = serverTransport;
  await import("../mcp-connections/mcp-connection-bridge-entry");
  clients.push(client);
  const observed = new McpInitializationTransport(transport);
  await client.connect(observed);
  bridge.initialization = observed.initialization;
  return client;
}

const tail = { tools: [{ name: "tail", inputSchema: { type: "object" } }] };

describe("native bridge catalog continuations", () => {
  it("takes the gateway's attach lease before it asks for anything", async () => {
    const order: string[] = [];
    bridge.attach.mockImplementationOnce(async () => {
      order.push("attach");
      return true;
    });
    bridge.request.mockImplementation(async (operation: string) => {
      order.push(operation);
      if (operation === "describe") return { tools: true };
      return tail;
    });
    const client = await openBridge();
    await client.listTools();
    expect(order.slice(0, 2)).toEqual(["attach", "describe"]);
  });

  it("isolates overlapping reads with identical upstream cursors and out-of-order responses", async () => {
    const releases: Array<() => void> = [];
    const gates = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const initialDeadlines: number[] = [];
    const continuationDeadlines: number[] = [];
    bridge.request.mockImplementation(async (operation: string, params?: { cursor?: string }, _signal?: AbortSignal, deadlineAt?: number) => {
      if (operation === "describe") return { tools: true };
      if (!params?.cursor) {
        const index = initialDeadlines.length;
        initialDeadlines.push(deadlineAt!);
        await gates[index];
        return { tools: [], nextCursor: "same-upstream-cursor" };
      }
      expect(params.cursor).toBe("same-upstream-cursor");
      continuationDeadlines.push(deadlineAt!);
      return tail;
    });
    const client = await openBridge();
    try {
      const first = client.listTools();
      await vi.waitFor(() => expect(initialDeadlines).toHaveLength(1));
      now += 5_000;
      const second = client.listTools();
      await vi.waitFor(() => expect(initialDeadlines).toHaveLength(2));
      releases[1]();
      const secondPage = await second;
      releases[0]();
      const firstPage = await first;
      expect(firstPage.nextCursor).toBeDefined();
      expect(secondPage.nextCursor).toBeDefined();
      now += 10_000;
      await expect(Promise.all([
        client.listTools({ cursor: firstPage.nextCursor }),
        client.listTools({ cursor: secondPage.nextCursor }),
      ])).resolves.toEqual([tail, tail]);
      expect(initialDeadlines).toEqual([1_060_000, 1_065_000]);
      expect(continuationDeadlines).toEqual(initialDeadlines);
    } finally {
      for (const release of releases) release();
    }
  });

  it("expires one read without expiring a later read using the same upstream cursor", async () => {
    const forwarded: Array<{ cursor?: string; deadlineAt?: number }> = [];
    bridge.request.mockImplementation(async (operation: string, params?: { cursor?: string }, _signal?: AbortSignal, deadlineAt?: number) => {
      if (operation === "describe") return { tools: true };
      forwarded.push({ cursor: params?.cursor, deadlineAt });
      return params?.cursor ? tail : { tools: [], nextCursor: "same-upstream-cursor" };
    });
    const client = await openBridge();
    const first = await client.listTools();
    now += 30_000;
    const second = await client.listTools();
    now += 31_000;
    await expect(client.listTools({ cursor: first.nextCursor })).rejects.toThrow("MCP catalog cursor expired");
    await expect(client.listTools({ cursor: second.nextCursor })).resolves.toEqual(tail);
    expect(forwarded).toEqual([
      { cursor: undefined, deadlineAt: 1_060_000 },
      { cursor: undefined, deadlineAt: 1_090_000 },
      { cursor: "same-upstream-cursor", deadlineAt: 1_090_000 },
    ]);
  });

  it("preserves one deadline while translating every continuation page", async () => {
    const deadlines: number[] = [];
    let pages = 0;
    bridge.request.mockImplementation(async (operation: string, params?: { cursor?: string }, _signal?: AbortSignal, deadlineAt?: number) => {
      if (operation === "describe") return { tools: true };
      if (pages > 0) expect(params?.cursor).toBe("same-upstream-cursor");
      deadlines.push(deadlineAt!);
      pages += 1;
      return { ...tail, ...(pages < 3 ? { nextCursor: "same-upstream-cursor" } : {}), _meta: { fixture: "preserved" } };
    });
    const client = await openBridge();
    const first = await client.listTools();
    now += 20_000;
    const second = await client.listTools({ cursor: first.nextCursor });
    now += 20_000;
    const third = await client.listTools({ cursor: second.nextCursor });
    expect(third).toEqual({ ...tail, _meta: { fixture: "preserved" } });
    expect(deadlines).toEqual([1_060_000, 1_060_000, 1_060_000]);
  });
});

describe("native bridge upstream forms", () => {
  const form = {
    message: "Remove /fixture/old? This cannot be undone.",
    requestedSchema: {
      type: "object" as const,
      properties: { confirm: { type: "boolean" as const, title: "Remove permanently" } },
      required: ["confirm"],
    },
    _meta: { "fixture/confirmation": "nonce-1", persist: ["session"] },
  };

  /** The owner sends one form during the call and returns what it got back. */
  function callThatAsks(): { routes: Array<ElicitationRoute | undefined> } {
    const routes: Array<ElicitationRoute | undefined> = [];
    bridge.request.mockImplementation(async (operation: string, ...rest: unknown[]) => {
      if (operation === "describe") return { tools: true };
      const onElicit = rest[5] as ElicitationRoute | undefined;
      routes.push(onElicit);
      const answer = onElicit ? await onElicit(form, new AbortController().signal) : undefined;
      return { content: [{ type: "text", text: JSON.stringify(answer ?? null) }] };
    });
    return { routes };
  }

  it("asks the agent's own client, with the form exactly as the server sent it", async () => {
    const { routes } = callThatAsks();
    const client = new Client(
      { name: "native-form-fixture", version: "1.0.0" },
      { capabilities: { elicitation: { form: {} } } },
    );
    const seen: ElicitRequestParams[] = [];
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      seen.push(request.params);
      return { action: "accept", content: { confirm: true }, _meta: { "client/approval": "kept" } };
    });
    await openBridge(client);

    const result = await client.callTool({ name: "remove", arguments: {} });

    expect(routes[0]).toBeTypeOf("function");
    // The agent's SDK client parses what it receives; the owner-side suite
    // proves the bridge is handed the server's form verbatim.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject(form);
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual({
      action: "accept", content: { confirm: true }, _meta: { "client/approval": "kept" },
    });
  });

  it("offers no route for an agent client that never declared elicitation", async () => {
    const { routes } = callThatAsks();
    const client = await openBridge();

    await client.callTool({ name: "remove", arguments: {} });

    expect(routes).toEqual([undefined]);
  });
});

describe("desktop-owned native bridge discovery", () => {
  it("preserves desktop identity, relay metadata, instructions and advertised subscriptions", async () => {
    const metadata = { "com.pwrdrvr.pwrdisk/interface": { owner: "desktop", desktopVersion: "2.0.0", relayVersion: "0.1.0" } };
    let skill = "Original safety brief.";
    bridge.request.mockImplementation(async (operation: string) => {
      if (operation === "describe") return {
        tools: true, resources: true, prompts: true,
        serverInfo: { name: "desktop", version: "2.0.0" }, instructions: "Read the current skill.", metadata,
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: true }, prompts: { listChanged: true } },
      };
      if (operation.endsWith("subscribe")) return {};
      if (operation === "resources/read") return { contents: [{ uri: "skill://fixture/SKILL.md", text: skill }] };
      return tail;
    });
    const client = await openBridge();
    expect(client.getServerVersion()).toEqual({ name: "desktop", version: "2.0.0" });
    expect(client.getInstructions()).toBe("Read the current skill.");
    expect(bridge.initialization?._meta).toEqual(metadata);
    expect(await client.readResource({ uri: "skill://fixture/SKILL.md" })).toMatchObject({ contents: [{ text: skill }] });
    const notifications: string[] = [];
    for (const schema of [ToolListChangedNotificationSchema, PromptListChangedNotificationSchema, ResourceListChangedNotificationSchema, ResourceUpdatedNotificationSchema]) {
      client.setNotificationHandler(schema, (notification) => { notifications.push(notification.method); });
    }
    for (const method of ["notifications/tools/list_changed", "notifications/prompts/list_changed", "notifications/resources/list_changed"]) bridge.event?.({ method });
    await client.subscribeResource({ uri: "skill://fixture/SKILL.md", _meta: { "fixture/approval": "retained" } });
    skill = "Updated safety brief.";
    bridge.event?.({ method: "notifications/resources/updated", params: { uri: "skill://fixture/SKILL.md", _meta: { revision: 2 } } });
    await vi.waitFor(() => expect(notifications).toHaveLength(4));
    expect(await client.readResource({ uri: "skill://fixture/SKILL.md" })).toMatchObject({ contents: [{ text: "Updated safety brief." }] });
    await client.unsubscribeResource({ uri: "skill://fixture/SKILL.md" });
    expect(bridge.request).toHaveBeenCalledWith("resources/subscribe", { uri: "skill://fixture/SKILL.md", _meta: { "fixture/approval": "retained" } }, expect.any(AbortSignal));
    expect(client.getServerCapabilities()?.resources).toEqual({ listChanged: true, subscribe: true });
  });

  it("ends the host connection on desktop EOF instead of reopening it under cached definitions", async () => {
    bridge.request.mockResolvedValue({ tools: true });
    const client = await openBridge();
    const onclose = vi.fn();
    client.onclose = onclose;
    bridge.event?.({ method: "connection/closed" });
    await vi.waitFor(() => expect(onclose).toHaveBeenCalledOnce());
    await expect(client.listTools()).rejects.toThrow();
    expect(bridge.request).toHaveBeenCalledTimes(1);
  });
});
