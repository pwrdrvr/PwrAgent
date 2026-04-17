import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexAppServer,
  FakeProvider,
  createTemporaryTestDirectory,
  defaultGrokAppServerConfigPath,
  defaultGrokAppServerConfigPaths,
} from "@pwragnt/agent-core";
import { GrokAppServerClient } from "../grok-app-server/client";

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
        summary: undefined,
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
          summary: undefined,
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
});
