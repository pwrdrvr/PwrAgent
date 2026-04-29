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

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("GrokAppServerClient", () => {
  it("lists threads, reads replay, and forwards turn notifications", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
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
    expect(startedTurn).toEqual({ threadId: "thread-1", turnId: "turn-1" });

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
    expect(notifications).toContain("turn/started");

    unsubscribe();
    await client.close();
  });

  it("starts review runs and normalizes review replay items", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-review-1",
    });
    const client = new GrokAppServerClient({ server });

    await client.startThread({ cwd: "/repo/workspace" });
    const startedReview = await client.startReview({
      threadId: "thread-1",
      target: { type: "baseBranch", branch: "main" },
      delivery: "inline",
    });

    expect(startedReview).toEqual({
      threadId: "thread-1",
      reviewThreadId: "thread-1",
      turnId: "turn-review-1",
    });
    expect(provider.runs[0]?.input[0]).toEqual({
      type: "text",
      text: expect.stringContaining("Review the code changes against the base branch 'main'"),
    });

    provider.runs[0]?.deferred.resolve({
      assistantText: JSON.stringify({
        findings: [],
        overall_correctness: "patch is correct",
        overall_explanation: "No issues found.",
        overall_confidence_score: 0.7,
      }),
      providerResponseId: "resp_review",
    });
    await flushAsync();

    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      entries: [
        {
          type: "review",
          displayText: "Review changes against main",
        },
        {
          type: "review",
          review: expect.stringContaining("No issues found."),
          output: {
            findings: [],
            overall_correctness: "patch is correct",
            overall_explanation: "No issues found.",
            overall_confidence_score: 0.7,
          },
        },
      ],
      messages: [],
    });

    await client.close();
  });

  it("fails a Grok turn that resolves without assistant text", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });
    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await client.startThread({ cwd: "/repo/workspace", model: "grok-4.20-reasoning" });
    const startedTurn = await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "Return a visible answer" }],
    });
    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        toolName: "search_code",
        arguments: { query: "needle" },
      },
    });
    await provider.runs[0]?.emit({
      type: "item_completed",
      item: {
        id: "tool-1",
        type: "dynamicToolCall",
        text: "No matches.",
        toolName: "search_code",
        success: true,
        arguments: { query: "needle" },
        commandAction: "search",
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "",
      providerResponseId: "resp_empty",
    });
    await flushAsync();

    expect(startedTurn).toEqual({ threadId: "thread-1", turnId: "turn-1" });
    expect(notifications).toEqual([
      "turn/started",
      "item/started",
      "item/completed",
      "turn/failed",
    ]);
    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      entries: [
        {
          type: "message",
          role: "user",
          text: "Return a visible answer",
        },
        {
          type: "activity",
          summary: "Explored 1 item",
          details: [
            {
              kind: "read",
              label: "Searched code",
            },
          ],
        },
      ],
      lastUserMessage: "Return a visible answer",
      lastAssistantMessage: undefined,
    });

    unsubscribe();
    await client.close();
  });

  it("preserves Grok user image parts in thread replay", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });

    await client.startThread({ model: "grok-4.20-reasoning" });
    await client.startTurn({
      threadId: "thread-1",
      input: [
        { type: "text", text: "What's in this picture?" },
        { type: "image", url: "data:image/jpeg;base64,AQID" },
      ],
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "It is a photo.",
      providerResponseId: "resp_1",
    });
    await flushAsync();

    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      entries: [
        {
          type: "message",
          role: "user",
          text: "What's in this picture?",
          parts: [
            { type: "text", text: "What's in this picture?" },
            { type: "image", url: "data:image/jpeg;base64,AQID" },
          ],
        },
        {
          type: "message",
          role: "assistant",
          text: "It is a photo.",
        },
      ],
      messages: [
        {
          role: "user",
          text: "What's in this picture?",
          parts: [
            { type: "text", text: "What's in this picture?" },
            { type: "image", url: "data:image/jpeg;base64,AQID" },
          ],
        },
        {
          role: "assistant",
          text: "It is a photo.",
        },
      ],
    });

    await client.close();
  });

  it("hydrates Grok tool replay items as transcript activity", async () => {
    const server = {
      request: async (method: string): Promise<unknown> => {
        if (method === "initialize") {
          return {
            serverInfo: { name: "@pwragnt/grok-app-server", version: "1.0.0" },
            methods: ["thread/read"],
          };
        }
        if (method === "thread/read") {
          return {
            messages: [
              { role: "user", text: "Find the code" },
              { role: "assistant", text: "Found it." },
            ],
            items: [
              {
                id: "user-1",
                type: "userMessage",
                role: "user",
                text: "Find the code",
              },
              {
                id: "search-1",
                type: "dynamicToolCall",
                status: "completed",
                toolName: "search_code",
                commandAction: "search",
                arguments: { path: "src" },
                success: true,
              },
              {
                id: "shell-1",
                type: "commandExecution",
                status: "failed",
                toolName: "shell_command",
                command: "rg needle .",
                commandAction: "search",
                aggregatedOutput: "src/file.ts:needle",
                durationMs: 1_250,
                exitCode: 1,
                success: false,
              },
              {
                id: "assistant-1",
                type: "agentMessage",
                role: "assistant",
                text: "Found it.",
              },
            ],
          };
        }
        throw new Error(`unexpected request ${method}`);
      },
      notify: async () => undefined,
      onNotification: () => () => undefined,
    };
    const client = new GrokAppServerClient({ server });

    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      entries: [
        {
          type: "message",
          role: "user",
          text: "Find the code",
        },
        {
          type: "activity",
          summary: "Explored 1 item, Ran 1 command",
          status: "failed",
          details: [
            {
              kind: "read",
              label: "Searched src",
              path: "src",
              status: "completed",
            },
            {
              kind: "command",
              label: "rg needle . (1.3s)",
              status: "failed",
              command: {
                displayCommand: "rg needle .",
                rawCommand: "rg needle .",
                output: "src/file.ts:needle",
                exitCode: 1,
                durationMs: 1_250,
              },
            },
          ],
        },
        {
          type: "message",
          role: "assistant",
          text: "Found it.",
        },
      ],
      lastUserMessage: "Find the code",
      lastAssistantMessage: "Found it.",
    });

    await client.close();
  });

  it("preserves restored rollout activity groups at their original item positions", async () => {
    const server = {
      request: async (method: string): Promise<unknown> => {
        if (method === "initialize") {
          return {
            serverInfo: { name: "@pwragnt/grok-app-server", version: "1.0.0" },
            methods: ["thread/read"],
          };
        }
        if (method === "thread/read") {
          return {
            messages: [
              { role: "user", text: "Replay restored rollout order." },
              { role: "assistant", text: "I am checking the first file." },
              { role: "assistant", text: "Now I am checking the second file." },
              { role: "assistant", text: "Done." },
            ],
            items: [
              {
                id: "user-1",
                type: "userMessage",
                role: "user",
                text: "Replay restored rollout order.",
              },
              {
                id: "commentary-1",
                type: "agentMessage",
                role: "assistant",
                text: "I am checking the first file.",
                phase: "commentary",
              },
              {
                id: "cmd-1",
                type: "commandExecution",
                status: "completed",
                command: "sed -n 1,40p src/a.ts",
                commandActions: [{ type: "read", path: "/repo/src/a.ts" }],
                durationMs: 1_200,
              },
              {
                id: "commentary-2",
                type: "agentMessage",
                role: "assistant",
                text: "Now I am checking the second file.",
                phase: "commentary",
              },
              {
                id: "cmd-2",
                type: "commandExecution",
                status: "completed",
                command: "sed -n 1,40p src/b.ts",
                commandActions: [{ type: "read", path: "/repo/src/b.ts" }],
                durationMs: 2_500,
              },
              {
                id: "final-1",
                type: "agentMessage",
                role: "assistant",
                text: "Done.",
                phase: "final",
              },
            ],
          };
        }
        throw new Error(`unexpected request ${method}`);
      },
      notify: async () => undefined,
      onNotification: () => () => undefined,
    };
    const client = new GrokAppServerClient({ server });

    const replay = await client.readThread({ threadId: "thread-1" });

    expect(replay.entries.map((entry) => `${entry.type}:${entry.id}`)).toEqual([
      "message:message-1",
      "message:message-2",
      "activity:activity-cmd-1",
      "message:message-3",
      "activity:activity-cmd-2",
      "message:message-4",
    ]);
    expect(replay.entries).toMatchObject([
      { type: "message", role: "user", text: "Replay restored rollout order." },
      { type: "message", role: "assistant", text: "I am checking the first file." },
      {
        type: "activity",
        summary: "Ran 1 command",
        details: [{ label: "sed -n 1,40p src/a.ts (1.2s)" }],
      },
      { type: "message", role: "assistant", text: "Now I am checking the second file." },
      {
        type: "activity",
        summary: "Ran 1 command",
        details: [{ label: "sed -n 1,40p src/b.ts (2.5s)" }],
      },
      { type: "message", role: "assistant", text: "Done." },
    ]);

    await client.close();
  });

  it("preserves Grok messages when replay items only contain tool activity", async () => {
    const server = {
      request: async (method: string): Promise<unknown> => {
        if (method === "initialize") {
          return {
            serverInfo: { name: "@pwragnt/grok-app-server", version: "1.0.0" },
            methods: ["thread/read"],
          };
        }
        if (method === "thread/read") {
          return {
            messages: [
              { role: "user", text: "Find the code" },
              { role: "assistant", text: "Found it." },
            ],
            items: [
              {
                id: "search-1",
                type: "dynamicToolCall",
                status: "completed",
                toolName: "search_code",
                commandAction: "search",
                arguments: { path: "src" },
                success: true,
              },
            ],
          };
        }
        throw new Error(`unexpected request ${method}`);
      },
      notify: async () => undefined,
      onNotification: () => () => undefined,
    };
    const client = new GrokAppServerClient({ server });

    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      entries: [
        {
          type: "message",
          role: "user",
          text: "Find the code",
        },
        {
          type: "activity",
          summary: "Explored 1 item",
          details: [
            {
              kind: "read",
              label: "Searched src",
              path: "src",
              status: "completed",
            },
          ],
        },
        {
          type: "message",
          role: "assistant",
          text: "Found it.",
        },
      ],
      messages: [
        {
          id: "message-1",
          role: "user",
          text: "Find the code",
        },
        {
          id: "message-2",
          role: "assistant",
          text: "Found it.",
        },
      ],
      lastUserMessage: "Find the code",
      lastAssistantMessage: "Found it.",
    });

    await client.close();
  });

  it("surfaces Grok tool calls and search sources in thread replay", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });

    await client.startThread({ model: "grok-4.20-reasoning" });
    await client.startTurn({
      threadId: "thread-1",
      input: [{ type: "text", text: "Search for Matt Van Horn" }],
    });

    await provider.runs[0]?.emit({
      type: "item_started",
      item: {
        id: "call-search-web",
        type: "dynamicToolCall",
        text: "search_web",
        toolName: "search_web",
        arguments: { query: "Matt Van Horn" },
      },
    });
    await provider.runs[0]?.emit({
      type: "item_completed",
      item: {
        id: "call-search-web",
        type: "dynamicToolCall",
        text: "Matt Van Horn co-founded Zimride and works on startup investing.",
        toolName: "search_web",
        success: true,
        arguments: { query: "Matt Van Horn" },
        data: {
          output: "Matt Van Horn co-founded Zimride and works on startup investing.",
          sources: [
            {
              title: "Matt Van Horn profile",
              url: "https://example.com/matt-van-horn",
            },
          ],
        },
      },
    });
    provider.runs[0]?.deferred.resolve({
      assistantText: "I found a profile.",
      providerResponseId: "resp_1",
    });
    await flushAsync();

    const replay = await client.readThread({ threadId: "thread-1" });
    expect(replay.entries).toEqual([
      {
        type: "message",
        id: "message-1",
        role: "user",
        text: "Search for Matt Van Horn",
      },
      {
        type: "activity",
        id: "activity-call-search-web",
        summary: "Searched Web",
        status: "completed",
        details: [
          {
            id: "call-search-web",
            kind: "read",
            label:
              "Searched Web: Matt Van Horn - Matt Van Horn co-founded Zimride and works on startup investing.",
            status: "completed",
          },
          {
            id: "call-search-web-source-1",
            kind: "read",
            label: "Matt Van Horn profile",
            url: "https://example.com/matt-van-horn",
            status: "completed",
          },
        ],
      },
      {
        type: "message",
        id: "message-2",
        role: "assistant",
        text: "I found a profile.",
      },
    ]);

    await client.close();
  });

  it("archives Grok threads while keeping replay readable", async () => {
    const server = new CodexAppServer({
      provider: new FakeProvider(),
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });
    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await client.startThread({ cwd: "/repo/workspace" });
    await expect(client.archiveThread({ threadId: "thread-1" })).resolves.toEqual({
      threadId: "thread-1",
    });

    await expect(client.listThreads()).resolves.toEqual([]);
    await expect(client.readThread({ threadId: "thread-1" })).resolves.toMatchObject({
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
      },
    });
    expect(notifications).toContain("thread/archived");

    unsubscribe();
    await client.close();
  });

  it("restores archived Grok threads through the app-server contract", async () => {
    const server = new CodexAppServer({
      provider: new FakeProvider(),
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });
    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await client.startThread({ cwd: "/repo/workspace" });
    await client.archiveThread({ threadId: "thread-1" });
    await expect(client.listThreads()).resolves.toEqual([]);
    await expect(client.listThreads({ archived: true })).resolves.toMatchObject([
      {
        id: "thread-1",
        source: "grok",
      },
    ]);

    await expect(client.restoreThread({ threadId: "thread-1" })).resolves.toEqual({
      threadId: "thread-1",
    });
    await expect(client.listThreads()).resolves.toMatchObject([
      {
        id: "thread-1",
        source: "grok",
      },
    ]);
    expect(notifications).toContain("thread/unarchived");

    unsubscribe();
    await client.close();
  });

  it("renames Grok threads through the app-server contract", async () => {
    const server = new CodexAppServer({
      provider: new FakeProvider(),
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: () => "turn-1",
    });
    const client = new GrokAppServerClient({ server });
    const notifications: string[] = [];
    const unsubscribe = client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    await client.startThread({ cwd: "/repo/workspace" });
    await expect(
      client.renameThread({
        threadId: "thread-1",
        name: "Renamed Grok thread",
      })
    ).resolves.toEqual({
      threadId: "thread-1",
    });

    await expect(client.listThreads()).resolves.toMatchObject([
      {
        id: "thread-1",
        title: "Renamed Grok thread",
        titleSource: "explicit",
      },
    ]);
    expect(notifications).toContain("thread/name/updated");

    unsubscribe();
    await client.close();
  });

  it("preserves the full Grok message sequence when last-message summaries are also present", async () => {
    const provider = new FakeProvider();
    const server = new CodexAppServer({
      provider,
      threadIdGenerator: () => "thread-1",
      turnIdGenerator: (() => {
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
      "XAI_API_KEY=config-key\nGROK_MODEL=grok-4.20-non-reasoning\nXAI_BASE_URL=https://api.example.test/v1\n",
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
        'grok_model = "grok-4.20-non-reasoning"',
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

  it("fails missing API key before recording a synthetic outbound initialize", async () => {
    const originalHome = process.env.HOME;
    const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const originalXaiApiKey = process.env.XAI_API_KEY;
    const originalGrokModel = process.env.GROK_MODEL;
    const originalXaiBaseUrl = process.env.XAI_BASE_URL;
    delete process.env.XAI_API_KEY;
    delete process.env.GROK_MODEL;
    delete process.env.XAI_BASE_URL;
    delete process.env.XDG_CONFIG_HOME;

    const temp = await createTemporaryTestDirectory();
    const observed: unknown[] = [];
    process.env.HOME = temp.path;

    try {
      const client = new GrokAppServerClient({
        connectionObserver: {
          onMessage: (event) => {
            observed.push(event);
          },
        },
      });

      await expect(client.getInitializeResult()).rejects.toThrow(
        "grok app server unavailable: XAI_API_KEY is not set",
      );
      expect(observed).toEqual([]);
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
      if (originalXaiApiKey === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = originalXaiApiKey;
      }
      if (originalGrokModel === undefined) {
        delete process.env.GROK_MODEL;
      } else {
        process.env.GROK_MODEL = originalGrokModel;
      }
      if (originalXaiBaseUrl === undefined) {
        delete process.env.XAI_BASE_URL;
      } else {
        process.env.XAI_BASE_URL = originalXaiBaseUrl;
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
        model: "grok-4.20-non-reasoning",
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
          model: "grok-4.20-non-reasoning",
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
            turnId: "turn-1",
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
        turnId: "turn-1",
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
