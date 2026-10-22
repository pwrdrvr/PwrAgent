import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  request: vi.fn(),
  transport: undefined as Transport | undefined,
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function () { return bridge.transport; }),
}));
vi.mock("../mcp-connections/mcp-connection-rpc-client.js", () => ({
  ConnectionRpcClient: vi.fn(function () { return { request: bridge.request }; }),
}));

const clients: Client[] = [];
let now: number;

beforeEach(() => {
  vi.resetModules();
  bridge.request.mockReset();
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

async function openBridge(): Promise<Client> {
  const [transport, serverTransport] = InMemoryTransport.createLinkedPair();
  bridge.transport = serverTransport;
  await import("../mcp-connections/mcp-connection-bridge-entry");
  const client = new Client({ name: "native-catalog-fixture", version: "1.0.0" });
  clients.push(client);
  await client.connect(transport);
  return client;
}

const tail = { tools: [{ name: "tail", inputSchema: { type: "object" } }] };

describe("native bridge catalog continuations", () => {
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
