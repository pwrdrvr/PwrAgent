import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServer,
  FakeProvider,
  createTemporaryTestDirectory,
  defaultGrokAppServerConfigPath,
  defaultGrokAppServerConfigPaths,
} from "@pwragnt/agent-core";
import type { AppServerNotification } from "@pwragnt/shared";
import { GrokAppServerClient } from "../grok-app-server/client";
import { ProtocolCaptureStore } from "../testing/capture-store";
import { createProtocolCaptureObserver } from "../testing/protocol-capture";

describe("GrokAppServerClient", () => {
  it("lists threads, reads replay, and forwards turn notifications", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      runIdGenerator: () => "turn-1",
    });

    const client = new GrokAppServerClient({
      server,
      directoryResolver: async (projectKey) =>
        projectKey
          ? [
              {
                id: "/repo/workspace",
                label: "workspace",
                path: "/repo/workspace",
                kind: "local",
              },
            ]
          : [],
    });

    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    const initialize = await client.getInitializeResult();
    expect(initialize.serverInfo?.name).toBe("@pwragnt/grok-app-server");
    expect(initialize.methods).toContain("thread/list");
    expect(initialize.methods).toContain("turn/start");

    const created = await client.startThread({
      cwd: "/repo/workspace",
      model: "grok-4.20-reasoning",
    });
    expect(created).toEqual({ threadId: "thread-1" });

    const threads = await client.listThreads();
    expect(threads).toEqual([
      {
        id: "thread-1",
        title: "Untitled thread",
        titleSource: "fallback",
        summary: undefined,
        model: "grok-4.20-reasoning",
        serviceTier: undefined,
        reasoningEffort: undefined,
        fastMode: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        linkedDirectories: [
          {
            id: "/repo/workspace",
            label: "workspace",
            path: "/repo/workspace",
            kind: "local",
          },
        ],
        source: "grok",
      },
    ]);

    const startedTurn = await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "Ship Unit 3" }],
    });
    expect(startedTurn).toEqual({ threadId: "thread-1", runId: "turn-1" });

    provider.runs[0]?.deferred.resolve({
      assistantText: "Done.",
      providerResponseId: "resp_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(await client.listThreads()).toEqual([
      {
        id: "thread-1",
        title: "Ship Unit 3",
        titleSource: "derived",
        summary: "Done.",
        model: "grok-4.20-reasoning",
        serviceTier: undefined,
        reasoningEffort: undefined,
        fastMode: undefined,
        createdAt: expect.any(Number),
        updatedAt: expect.any(Number),
        linkedDirectories: [
          {
            id: "/repo/workspace",
            label: "workspace",
            path: "/repo/workspace",
            kind: "local",
          },
        ],
        source: "grok",
      },
    ]);

    const replay = await client.readThread({ threadId: "thread-1" });
    expect(replay).toEqual({
      entries: [
        {
          type: "message",
          id: "message-1",
          role: "user",
          text: "Ship Unit 3",
        },
        {
          type: "message",
          id: "message-2",
          role: "assistant",
          text: "Done.",
        },
      ],
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "Ship Unit 3",
        },
        {
          id: "message-2",
          role: "assistant",
          text: "Done.",
        },
      ],
      lastUserMessage: "Ship Unit 3",
      lastAssistantMessage: "Done.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });
    expect(notifications).toContain("turn/completed");

    unsubscribe();
    await client.close();
  });

  it("preserves the full Grok message sequence when last-message summaries are also present", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      runIdGenerator: (() => {
        let index = 0;
        return () => `turn-${++index}`;
      })(),
    });

    const client = new GrokAppServerClient({ server });

    await client.startThread({
      model: "grok-4.20-reasoning",
    });

    await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "Who are you?" }],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "I'm Grok 4, built by xAI.",
      providerResponseId: "resp_1",
    });
    await Promise.resolve();
    await Promise.resolve();

    await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "What model are you?" }],
    });
    await Promise.resolve();

    await expect(client.readThread({ threadId: "thread-1" })).resolves.toEqual({
      entries: [
        {
          type: "message",
          id: "message-1",
          role: "user",
          text: "Who are you?",
        },
        {
          type: "message",
          id: "message-2",
          role: "assistant",
          text: "I'm Grok 4, built by xAI.",
        },
        {
          type: "message",
          id: "message-3",
          role: "user",
          text: "What model are you?",
        },
      ],
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "Who are you?",
        },
        {
          id: "message-2",
          role: "assistant",
          text: "I'm Grok 4, built by xAI.",
        },
        {
          id: "message-3",
          role: "user",
          text: "What model are you?",
        },
      ],
      lastUserMessage: "What model are you?",
      lastAssistantMessage: "I'm Grok 4, built by xAI.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });

    await client.close();
  });

  it("initializes from ~/.config/grok-app-server when env vars are absent", async () => {
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_MODEL;
    delete process.env.XAI_BASE_URL;
    delete process.env.XDG_CONFIG_HOME;

    const temp = await createTemporaryTestDirectory();
    process.env.HOME = temp.path;
    const [configPath] = defaultGrokAppServerConfigPaths({ homeDir: temp.path });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      "XAI_API_KEY=config-key\nGROK_MODEL=grok-4.20-fast\nXAI_BASE_URL=https://api.example.test/v1\n",
      "utf8",
    );

    try {
      const client = new GrokAppServerClient();
      await expect(client.getInitializeResult()).resolves.toEqual(
        expect.objectContaining({
          serverInfo: expect.objectContaining({
            name: "@pwragnt/grok-app-server",
          }),
        }),
      );
      await client.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      await temp.cleanup();
    }
  });

  it("initializes from config.toml when env vars are absent", async () => {
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_MODEL;
    delete process.env.XAI_BASE_URL;
    delete process.env.XDG_CONFIG_HOME;

    const temp = await createTemporaryTestDirectory();
    process.env.HOME = temp.path;
    const configPath = defaultGrokAppServerConfigPath({ homeDir: temp.path });
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      [
        'xai_api_key = "config-key"',
        'grok_model = "grok-4.20-fast"',
        'xai_base_url = "https://api.example.test/v1"',
        "",
      ].join("\n"),
      "utf8",
    );

    try {
      const client = new GrokAppServerClient();
      await expect(client.getInitializeResult()).resolves.toEqual(
        expect.objectContaining({
          serverInfo: expect.objectContaining({
            name: "@pwragnt/grok-app-server",
          }),
        }),
      );
      await client.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
      if (originalXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
      }
      await temp.cleanup();
    }
  });

  it("reloads persisted Grok thread metadata after client recreation", async () => {
    const temp = await createTemporaryTestDirectory();
    const stateRoot = path.join(temp.path, "state");

    try {
      const firstClient = new GrokAppServerClient({
        apiKey: "test-key",
        stateRoot,
        threadIdGenerator: () => "thread-1",
      });
      await firstClient.startThread({
        model: "grok-4.20-fast",
      });
      await firstClient.close();

      const secondClient = new GrokAppServerClient({
        apiKey: "test-key",
        stateRoot,
      });

      await expect(secondClient.listThreads()).resolves.toEqual([
        {
          id: "thread-1",
          title: "Untitled thread",
          titleSource: "fallback",
          summary: undefined,
          model: "grok-4.20-fast",
          serviceTier: undefined,
          reasoningEffort: undefined,
          fastMode: undefined,
          createdAt: expect.any(Number),
          updatedAt: expect.any(Number),
          linkedDirectories: [],
          source: "grok",
        },
      ]);
      await expect(secondClient.readThread({ threadId: "thread-1" })).resolves.toEqual({
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      });
      await secondClient.close();
    } finally {
      await temp.cleanup();
    }
  });

  it("records Grok boundary traffic for requests, notifications, and inbound requests", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-grok-recording-"));

    try {
      const notificationListeners = new Set<
        (notification: AppServerNotification) => void | Promise<void>
      >();
      let requestHandler:
        | ((
            method: string,
            params?: Record<string, unknown>
          ) => Promise<unknown> | unknown)
        | undefined;

      const server = {
        request: async (method: string, params?: unknown): Promise<unknown> => {
          if (method === "initialize") {
            return {
              serverInfo: {
                name: "@pwragnt/grok-app-server",
                version: "1.0.0"
              },
              methods: ["thread/list"]
            };
          }

          if (method === "thread/list") {
            return { threads: [] };
          }

          throw new Error(`unexpected request ${method} ${JSON.stringify(params)}`);
        },
        notify: async () => undefined,
        onNotification: (
          handler: (notification: AppServerNotification) => void | Promise<void>
        ) => {
          notificationListeners.add(handler);
          return () => {
            notificationListeners.delete(handler);
          };
        },
        onRequest: (
          handler: (
            method: string,
            params?: Record<string, unknown>
          ) => Promise<unknown> | unknown
        ) => {
          requestHandler = handler;
          return () => {
            requestHandler = undefined;
          };
        }
      };

      const store = new ProtocolCaptureStore({
        backend: "grok",
        captureId: "grok-capture-1",
        rootDir
      });
      const client = new GrokAppServerClient({
        server,
        connectionObserver: createProtocolCaptureObserver({
          backend: "grok",
          store
        })
      });

      client.onRequest(async () => ({ decision: "approve" }));

      await client.getInitializeResult();
      await client.listThreads();

      for (const listener of notificationListeners) {
        await listener({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }]
            }
          }
        });
      }

      await requestHandler?.("turn/requestApproval", {
        threadId: "thread-1",
        runId: "turn-1",
        requestId: "approval-1"
      });

      await store.close();
      await client.close();

      const lines = (await fs.readFile(path.join(rootDir, "grok-capture-1.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(
        lines.some(
          (line) =>
            line.backend === "grok" &&
            line.direction === "outbound" &&
            line.kind === "request" &&
            line.method === "initialize"
        )
      ).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.direction === "inbound" &&
            line.kind === "response" &&
            line.id === "rpc-1"
        )
      ).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.direction === "inbound" &&
            line.kind === "notification" &&
            line.method === "turn/completed"
        )
      ).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.direction === "inbound" &&
            line.kind === "request" &&
            line.method === "turn/requestApproval" &&
            line.id === "approval-1"
        )
      ).toBe(true);
      expect(
        lines.some(
          (line) =>
            line.direction === "outbound" &&
            line.kind === "response" &&
            line.id === "approval-1"
        )
      ).toBe(true);
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
