import { describe, expect, it, vi } from "vitest";
import type {
  AppServerNotification,
  AppServerPendingRequestNotification,
} from "@pwragent/shared";
import { GrokAppServerClient } from "../grok-app-server/client";

type FakeServer = {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(
    handler: (notification: AppServerNotification) => void | Promise<void>,
  ): () => void;
  onRequest(
    handler: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<unknown> | unknown,
  ): () => void;
};

function createFakeServer() {
  const notifications = new Set<
    (notification: AppServerNotification) => void | Promise<void>
  >();
  let requestHandler:
    | ((
        method: string,
        params?: Record<string, unknown>,
      ) => Promise<unknown> | unknown)
    | undefined;
  const requests: Array<{ method: string; params?: unknown }> = [];
  const notified: Array<{ method: string; params?: unknown }> = [];
  const server: FakeServer = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (method === "initialize") {
        return {
          serverInfo: {
            name: "@pwragent/grok-app-server",
            version: "0.1.0",
          },
          methods: [
            "thread/list",
            "thread/start",
            "thread/resume",
            "thread/read",
            "turn/start",
          ],
        };
      }
      if (method === "thread/list") {
        return {
          threads: [
            {
              threadId: "thread-1",
              title: "Process boundary",
              projectKey: "/repo",
              createdAt: 10,
              updatedAt: 20,
            },
          ],
        };
      }
      if (method === "thread/start" || method === "thread/resume") {
        return { threadId: "thread-1" };
      }
      if (method === "turn/start") {
        return { threadId: "thread-1", turnId: "turn-1" };
      }
      if (method === "thread/read") {
        return {
          threadId: "thread-1",
          messages: [
            { id: "message-1", role: "user", text: "Hello" },
            { id: "message-2", role: "assistant", text: "Hi" },
          ],
          items: [],
        };
      }
      if (method === "pwragent/xai/generateObject") {
        return {
          object: { title: "Child process" },
          cachedTokens: 12,
        };
      }
      throw new Error(`Unexpected request ${method}`);
    },
    notify: async (method, params) => {
      notified.push({ method, params });
    },
    onNotification: (handler) => {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    onRequest: (handler) => {
      requestHandler = handler;
      return () => {
        requestHandler = undefined;
      };
    },
  };

  return {
    server,
    requests,
    notified,
    emitNotification: async (notification: AppServerNotification) => {
      for (const listener of notifications) {
        await listener(notification);
      }
    },
    emitRequest: async (
      method: string,
      params?: Record<string, unknown>,
    ): Promise<unknown> => {
      if (!requestHandler) {
        throw new Error("request handler missing");
      }
      return await requestHandler(method, params);
    },
  };
}

describe("GrokAppServerClient", () => {
  it("coalesces initialize and normalizes representative thread operations", async () => {
    const fake = createFakeServer();
    const client = new GrokAppServerClient({
      server: fake.server,
      directoryResolver: async (projectKey) =>
        projectKey
          ? [{ id: projectKey, path: projectKey, label: "repo", kind: "local" }]
          : [],
    });

    const [initialize, threads] = await Promise.all([
      client.getInitializeResult(),
      client.listThreads(),
    ]);
    expect(initialize.serverInfo?.name).toBe("@pwragent/grok-app-server");
    expect(
      fake.requests.filter((request) => request.method === "initialize"),
    ).toHaveLength(1);
    expect(fake.notified).toEqual([{ method: "initialized", params: {} }]);
    expect(threads).toEqual([
      {
        id: "thread-1",
        title: "Process boundary",
        titleSource: "explicit",
        summary: undefined,
        projectKey: "/repo",
        createdAt: 10,
        updatedAt: 20,
        archivedAt: undefined,
        model: undefined,
        serviceTier: undefined,
        reasoningEffort: undefined,
        fastMode: undefined,
        linkedDirectories: [
          { id: "/repo", path: "/repo", label: "repo", kind: "local" },
        ],
        source: "grok",
      },
    ]);

    await expect(client.startThread({ cwd: "/repo" })).resolves.toEqual({
      threadId: "thread-1",
    });
    await expect(
      client.startTurn({
        threadId: "thread-1",
        input: [{ type: "text", text: "Hello" }],
      }),
    ).resolves.toEqual({ threadId: "thread-1", turnId: "turn-1" });
    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      messages: [
        { id: "message-1", role: "user", text: "Hello" },
        { id: "message-2", role: "assistant", text: "Hi" },
      ],
      lastUserMessage: "Hello",
      lastAssistantMessage: "Hi",
    });

    await client.close();
  });

  it("forwards child notifications and bidirectional server requests", async () => {
    const fake = createFakeServer();
    const client = new GrokAppServerClient({ server: fake.server });
    const notifications: AppServerNotification[] = [];
    const requests: AppServerPendingRequestNotification[] = [];
    client.onNotification((notification) => {
      notifications.push(notification);
    });
    client.onRequest(async (request) => {
      requests.push(request);
      return { decision: "approve" };
    });

    await fake.emitNotification({
      method: "turn/started",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: { id: "turn-1", status: "in_progress" },
      },
    });
    await expect(
      fake.emitRequest("turn/requestApproval", {
        requestId: "approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).resolves.toEqual({ decision: "approve" });

    expect(notifications).toHaveLength(1);
    expect(requests).toEqual([
      {
        method: "turn/requestApproval",
        params: {
          requestId: "approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    ]);
    await client.close();
  });

  it("routes structured generation through the same server boundary", async () => {
    const fake = createFakeServer();
    const client = new GrokAppServerClient({ server: fake.server });

    await expect(
      client.generateObject({
        model: "grok-test",
        schema: { type: "object" },
        system: "Return JSON.",
        prompt: "Name the thread.",
        timeoutMs: 500,
      }),
    ).resolves.toEqual({
      object: { title: "Child process" },
      cachedTokens: 12,
    });
    expect(fake.requests).toContainEqual({
      method: "pwragent/xai/generateObject",
      params: {
        model: "grok-test",
        schema: { type: "object" },
        system: "Return JSON.",
        prompt: "Name the thread.",
        timeoutMs: 500,
      },
    });
    await client.close();
  });

  it("reports injected server failures and retries initialization", async () => {
    let initializeCount = 0;
    const fake = createFakeServer();
    const request = vi
      .spyOn(fake.server, "request")
      .mockImplementation(async (method, params) => {
        if (method === "initialize") {
          initializeCount += 1;
          if (initializeCount === 1) {
            throw new Error("startup failed");
          }
        }
        return await createFakeServer().server.request(method, params);
      });
    const client = new GrokAppServerClient({ server: fake.server });

    await expect(client.getInitializeResult()).rejects.toThrow("startup failed");
    await expect(client.getInitializeResult()).resolves.toMatchObject({
      serverInfo: { name: "@pwragent/grok-app-server" },
    });
    expect(request).toHaveBeenCalled();
    expect(initializeCount).toBe(2);
    await client.close();
  });
});
