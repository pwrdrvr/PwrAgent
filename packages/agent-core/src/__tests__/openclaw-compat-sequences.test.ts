import { describe, expect, it } from "vitest";
import { AppServerProtocolError } from "../app-server/protocol.js";
import { createTestHarness, FakeProvider } from "../testing/test-harness.js";

type RequestTransport = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createTransport(
  server: { request: (method: string, params?: unknown) => Promise<unknown> },
  options?: { unsupportedMethods?: string[] },
): RequestTransport {
  const unsupportedMethods = new Set(options?.unsupportedMethods ?? []);
  return {
    request: async (method, params) => {
      if (unsupportedMethods.has(method)) {
        throw new AppServerProtocolError(`Unsupported method: ${method}`);
      }
      return await server.request(method, params);
    },
  };
}

async function requestWithFallbacks(params: {
  client: RequestTransport;
  methods: string[];
  payloads: unknown[];
}): Promise<unknown> {
  let lastError: unknown;
  for (const method of params.methods) {
    for (const payload of params.payloads) {
      try {
        return await params.client.request(method, payload);
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isMethodUnavailableError(error: unknown, method: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.toLowerCase() === `unsupported method: ${method.toLowerCase()}`;
}

function buildThreadDiscoveryPayloads(filter?: string, workspaceDir?: string): unknown[] {
  return [
    {
      query: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {
      filter: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {},
  ];
}

function buildThreadStartPayloads(workspaceDir: string, model?: string): unknown[] {
  return [
    { cwd: workspaceDir, model },
    { cwd: workspaceDir },
    {},
  ];
}

describe("OpenClaw compatibility sequences", () => {
  it("supports OpenClaw-style startup, turn start, and thread replay", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    const client = createTransport(server);

    const initializeResult = await client.request("initialize", {
      protocolVersion: "1.0",
      clientInfo: { name: "openclaw", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    });
    await server.notify("initialized", {});
    const models = await requestWithFallbacks({
      client,
      methods: ["model/list"],
      payloads: [{}],
    });
    const threadsBefore = await requestWithFallbacks({
      client,
      methods: ["thread/list", "thread/loaded/list"],
      payloads: buildThreadDiscoveryPayloads("grok", "/repo/workspace"),
    });
    const startedThread = await requestWithFallbacks({
      client,
      methods: ["thread/start", "thread/new"],
      payloads: buildThreadStartPayloads("/repo/workspace", "grok-4.20-reasoning"),
    });
    const startedTurn = await requestWithFallbacks({
      client,
      methods: ["turn/start"],
      payloads: [
        {
          threadId: "thread-1",
          input: [{ type: "text", text: "Ship the Grok app server." }],
          model: "grok-4.20-reasoning",
          collaborationMode: {
            mode: "default",
            settings: {
              model: "grok-4.20-reasoning",
              developerInstructions: null,
            },
          },
        },
      ],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Shipped.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();
    const replay = await requestWithFallbacks({
      client,
      methods: ["thread/read"],
      payloads: [{ threadId: "thread-1", includeTurns: true }],
    });

    expect(initializeResult).toEqual(
      expect.objectContaining({
        serverInfo: {
          name: "@pwragnt/grok-app-server",
          version: "0.1.0",
        },
        methods: expect.arrayContaining([
          "thread/list",
          "thread/loaded/list",
          "thread/start",
          "thread/new",
          "thread/read",
          "review/start",
          "thread/compact/start",
        ]),
      }),
    );
    expect(models).toEqual({
      data: expect.arrayContaining([
        expect.objectContaining({ id: "grok-4.20-reasoning", provider: "xai" }),
      ]),
    });
    expect(threadsBefore).toEqual({ threads: [] });
    expect(startedThread).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      }),
    );
    expect(startedTurn).toEqual({ threadId: "thread-1", runId: "turn-1" });
    expect(provider.runs[0]?.input).toEqual([
      { type: "text", text: "Ship the Grok app server." },
    ]);
    expect(replay).toEqual({
      threadId: "thread-1",
      thread: expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
        model: "grok-4.20-reasoning",
      }),
      messages: [
        { role: "user", text: "Ship the Grok app server." },
        { role: "assistant", text: "Shipped." },
      ],
      lastUserMessage: "Ship the Grok app server.",
      lastAssistantMessage: "Shipped.",
    });
    expect(notifications).toEqual([
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-1",
          turn: {
            id: "turn-1",
            status: "completed",
            output: [{ type: "text", text: "Shipped." }],
          },
        },
      },
    ]);
  });

  it("supports OpenClaw review and compaction sequences on the same thread", async () => {
    const provider = new FakeProvider();
    const { server, notifications } = createTestHarness({ provider });
    const client = createTransport(server);

    await server.request("thread/start", { cwd: "/repo/workspace" });
    await server.request("turn/start", {
      threadId: "thread-1",
      input: [{ type: "text", text: "Please check the uncommitted changes." }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Ready for review.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();

    notifications.length = 0;

    const reviewResult = await requestWithFallbacks({
      client,
      methods: ["review/start"],
      payloads: [
        {
          threadId: "thread-1",
          target: { type: "uncommittedChanges" },
          delivery: "inline",
        },
      ],
    });
    provider.runs[1]?.deferred.resolve({
      assistantText: "Review looks good.",
      providerResponseId: "resp_review_1",
    });
    await flushAsync();

    const compactionResult = await requestWithFallbacks({
      client,
      methods: ["thread/compact/start"],
      payloads: [{ threadId: "thread-1" }],
    });
    provider.runs[2]?.deferred.resolve({
      assistantText: "Compact thread summary.",
      providerResponseId: "resp_compact_1",
    });
    await flushAsync();

    expect(reviewResult).toEqual({
      reviewThreadId: "thread-1",
      runId: "turn-2",
    });
    expect(compactionResult).toEqual({
      threadId: "thread-1",
      runId: "turn-3",
      itemId: "turn-3-item",
    });
    expect(provider.runs[1]?.previousResponseId).toBe("resp_turn_1");
    expect(provider.runs[2]?.previousResponseId).toBe("resp_review_1");
    expect(notifications).toEqual([
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          item: {
            id: "turn-2-item",
            type: "exitedReviewMode",
            review: "Review looks good.",
          },
        },
      },
      {
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-2",
          turn: {
            id: "turn-2",
            status: "completed",
            output: [{ type: "text", text: "Review looks good." }],
          },
        },
      },
      {
        method: "item/started",
        params: {
          threadId: "thread-1",
          runId: "turn-3",
          item: {
            id: "turn-3-item",
            type: "contextCompaction",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          runId: "turn-3",
          item: {
            id: "turn-3-item",
            type: "contextCompaction",
            text: "Compact thread summary.",
          },
        },
      },
      {
        method: "thread/compacted",
        params: {
          threadId: "thread-1",
          itemId: "turn-3-item",
        },
      },
    ]);
  });

  it("keeps OpenClaw fallbacks and optional payload variants harmless", async () => {
    const provider = new FakeProvider();
    const { server } = createTestHarness({ provider });
    const client = createTransport(server, {
      unsupportedMethods: ["thread/list", "thread/start"],
    });

    const listed = await requestWithFallbacks({
      client,
      methods: ["thread/list", "thread/loaded/list"],
      payloads: buildThreadDiscoveryPayloads("ignored", "/repo/workspace"),
    });
    const created = await requestWithFallbacks({
      client,
      methods: ["thread/start", "thread/new"],
      payloads: buildThreadStartPayloads("/repo/workspace", "grok-4.20-reasoning"),
    });
    const resumed = await requestWithFallbacks({
      client,
      methods: ["thread/resume"],
      payloads: [
        {
          threadId: "thread-1",
          model: "grok-4.20-fast",
          approvalPolicy: "never",
          sandbox: "danger-full-access",
          persistExtendedHistory: false,
        },
      ],
    });
    const snakeCaseTurn = await requestWithFallbacks({
      client,
      methods: ["turn/start"],
      payloads: [
        {
          threadId: "thread-1",
          input: [{ type: "text", text: "Use snake_case collaboration mode." }],
          collaboration_mode: {
            mode: "default",
            settings: {
              model: "grok-4.20-fast",
              developer_instructions: null,
            },
          },
        },
      ],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "Handled snake_case payload.",
      providerResponseId: "resp_turn_1",
    });
    await flushAsync();

    expect(listed).toEqual({ threads: [] });
    expect(created).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        cwd: "/repo/workspace",
      }),
    );
    expect(resumed).toEqual(
      expect.objectContaining({
        threadId: "thread-1",
        model: "grok-4.20-fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      }),
    );
    expect(snakeCaseTurn).toEqual({
      threadId: "thread-1",
      runId: "turn-1",
    });
    expect(provider.runs[0]?.input).toEqual([
      { type: "text", text: "Use snake_case collaboration mode." },
    ]);
  });

  it("fails clearly for unsupported methods outside the consumed surface", async () => {
    const { server } = createTestHarness();

    await expect(server.request("thread/delete", { threadId: "thread-1" })).rejects.toThrow(
      "Unsupported method: thread/delete",
    );
  });
});
