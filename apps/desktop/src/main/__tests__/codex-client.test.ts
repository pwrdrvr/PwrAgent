import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcTransport } from "../codex-app-server/json-rpc";

class MockTransport implements JsonRpcTransport {
  static instances: MockTransport[] = [];
  static readThreadErrorByThreadId = new Map<string, { code: number; message: string }>();
  static threadStartResult: unknown = {
    thread: {
      id: "thread-3",
      cwd: "/Users/huntharo/.pwragnt/projects/2026-04-16-ab12cd"
    },
    model: "gpt-5.4"
  };
  static threadResumeResult: unknown = {
    threadId: "thread-2",
    threadName: "Ship desktop shell",
    cwd: "/Users/huntharo/pwrdrvr/PwrAgnt"
  };
  static turnStartResult: unknown = {
    thread: {
      id: "thread-2"
    },
    turn: {
      id: "turn-1"
    }
  };
  static turnInterruptResult: unknown = {
    thread: {
      id: "thread-2"
    },
    turn: {
      id: "turn-1"
    }
  };
  static turnInterruptResponseMode: "success" | "timeout" = "success";

  readonly sentMessages: string[] = [];
  private messageHandler: (message: string) => void = () => undefined;
  private closeHandler: (error?: Error) => void = () => undefined;

  constructor() {
    MockTransport.instances.push(this);
  }

  async connect(): Promise<void> {
    return;
  }

  async close(): Promise<void> {
    this.closeHandler();
  }

  send(message: string): void {
    this.sentMessages.push(message);

    const payload = JSON.parse(message) as {
      id?: string;
      method?: string;
    };

    if (payload.method === "initialize") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            serverInfo: {
              name: "Codex App Server",
              version: "1.0.0"
            }
          }
        })
      );
      return;
    }

    if (payload.method === "thread/list") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            threads: [
              {
                id: "thread-2",
                title: "Ship desktop shell",
                summary: "Hook up Electron and the sidebar",
                updatedAt: 1_763_500_000,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/PwrAgnt"
                }
              },
              {
                id: "thread-1",
                title: "Plan Codex compatibility",
                text: "Do not leak this planning prompt into the thread browser",
                updatedAt: 1_763_400_000,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/openclaw-codex-app-server"
                }
              }
            ]
          }
        })
      );
      return;
    }

    if (payload.method === "thread/read") {
      const threadId = (JSON.parse(message) as { params?: { threadId?: string } }).params?.threadId;
      const readThreadError = threadId
        ? MockTransport.readThreadErrorByThreadId.get(threadId)
        : undefined;
      if (readThreadError) {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            error: readThreadError
          })
        );
        return;
      }

      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            thread: {
              turns: [
                {
                  id: "turn-1",
                  startedAt: 1_763_500_100,
                  items: [
                    {
                      type: "userMessage",
                      id: "item-1",
                      content: [
                        {
                          type: "text",
                          text: "Show me the current desktop thread shell"
                        }
                      ]
                    },
                    {
                      type: "agentMessage",
                      id: "item-2",
                      phase: "commentary",
                      text: "I’m tracing the transcript scroll container."
                    },
                    {
                      type: "commandExecution",
                      id: "item-3",
                      status: "completed",
                      command: "/bin/zsh -lc 'sed -n 1,220p TranscriptList.tsx'",
                      commandActions: [
                        {
                          type: "read",
                          path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx"
                        }
                      ]
                    },
                    {
                      type: "commandExecution",
                      id: "item-4",
                      status: "completed",
                      command: "/bin/zsh -lc 'pwd && rg --files'",
                      commandActions: [
                        {
                          type: "unknown"
                        }
                      ]
                    },
                    {
                      type: "fileChange",
                      id: "item-5",
                      status: "completed",
                      changes: [
                        {
                          path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                          kind: {
                            type: "update"
                          },
                          diff: [
                            "--- a/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                            "+++ b/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                            "@@ -1,3 +1,4 @@",
                            " import { useCallback } from \"react\";",
                            "-import { TranscriptMessage } from \"./TranscriptMessage\";",
                            "+import { TranscriptActivity } from \"./TranscriptActivity\";",
                            "+import { TranscriptMessage } from \"./TranscriptMessage\";"
                          ].join("\n")
                        }
                      ]
                    },
                    {
                      type: "agentMessage",
                      id: "item-6",
                      text: "The desktop shell is live and listing Codex threads."
                    }
                  ]
                }
              ]
            }
          }
        })
      );
      return;
    }

    if (payload.method === "thread/start") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.threadStartResult
        })
      );
      return;
    }

    if (payload.method === "thread/resume") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.threadResumeResult
        })
      );
      return;
    }

    if (payload.method === "turn/start") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.turnStartResult
        })
      );
      return;
    }

    if (payload.method === "turn/interrupt") {
      if (MockTransport.turnInterruptResponseMode === "timeout") {
        return;
      }

      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.turnInterruptResult
        })
      );
      return;
    }

    if (payload.method === "skills/list") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: {
            data: [
              {
                cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
                skills: [
                  {
                    name: "frontend-design",
                    description: "Design and verify renderer UI work.",
                    shortDescription: "Renderer UI design workflow.",
                    path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
                    scope: "user",
                    enabled: true,
                  },
                ],
                errors: [],
              },
            ],
          },
        })
      );
    }
  }

  setMessageHandler(handler: (message: string) => void): void {
    this.messageHandler = handler;
  }

  setCloseHandler(handler: (error?: Error) => void): void {
    this.closeHandler = handler;
  }
}

vi.mock("../codex-app-server/stdio-transport", () => {
  class MockStdioJsonRpcTransport extends MockTransport {
    constructor() {
      super();
    }
  }

  return {
    StdioJsonRpcTransport: MockStdioJsonRpcTransport
  };
});

describe("CodexAppServerClient", () => {
  beforeEach(() => {
    MockTransport.instances.length = 0;
    MockTransport.readThreadErrorByThreadId.clear();
    MockTransport.threadStartResult = {
      thread: {
        id: "thread-3",
        cwd: "/Users/huntharo/.pwragnt/projects/2026-04-16-ab12cd"
      },
      model: "gpt-5.4"
    };
    MockTransport.threadResumeResult = {
      threadId: "thread-2",
      threadName: "Ship desktop shell",
      cwd: "/Users/huntharo/pwrdrvr/PwrAgnt"
    };
    MockTransport.turnStartResult = {
      thread: {
        id: "thread-2"
      },
      turn: {
        id: "turn-1"
      }
    };
    MockTransport.turnInterruptResult = {
      thread: {
        id: "thread-2"
      },
      turn: {
        id: "turn-1"
      }
    };
    MockTransport.turnInterruptResponseMode = "success";
  });

  it("initializes once and normalizes thread/list results", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async (projectKey) =>
        projectKey
          ? [
              {
                id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                label: "PwrAgnt",
                path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
                kind: "worktree"
              }
            ]
          : []
    });

    const threads = await client.listThreads();

    expect(threads).toHaveLength(2);
    expect(threads[0]).toMatchObject({
      id: "thread-2",
      title: "Ship desktop shell",
      source: "codex",
      linkedDirectories: [
        {
          id: "/Users/huntharo/pwrdrvr/PwrAgnt",
          label: "PwrAgnt",
          path: "/Users/huntharo/pwrdrvr/PwrAgnt",
          worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
          kind: "worktree"
        }
      ]
    });
    expect(threads[1]?.title).toBe("Plan Codex compatibility");

    await client.close();
  });

  it("does not synthesize summaries from raw conversation text", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const threads = await client.listThreads();

    expect(threads[1]?.summary).toBeUndefined();

    await client.close();
  });

  it("extracts transcript messages and pagination metadata from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-2"
    });

    expect(replay).toEqual({
      entries: [
        {
          type: "message",
          id: "item-1",
          role: "user",
          text: "Show me the current desktop thread shell",
          createdAt: 1_763_500_100_000
        },
        {
          type: "message",
          id: "item-2",
          role: "assistant",
          text: "I’m tracing the transcript scroll container.",
          createdAt: 1_763_500_100_000,
          phase: "commentary"
        },
        {
          type: "activity",
          id: "activity-item-3",
          summary: "Explored 1 file, Ran 1 command, Edited 1 file",
          createdAt: 1_763_500_100_000,
          status: "completed",
          details: [
            {
              id: "item-3-1",
              kind: "read",
              label: "Read TranscriptList.tsx",
              path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
              status: "completed"
            },
            {
              id: "item-4-1",
              kind: "command",
              label: "pwd && rg --files",
              status: "completed"
            },
            {
              id: "item-5-1",
              kind: "write",
              label: "Update TranscriptList.tsx",
              path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
              status: "completed",
              fileDiff: {
                kind: "update",
                diff: [
                  "--- a/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                  "+++ b/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                  "@@ -1,3 +1,4 @@",
                  " import { useCallback } from \"react\";",
                  "-import { TranscriptMessage } from \"./TranscriptMessage\";",
                  "+import { TranscriptActivity } from \"./TranscriptActivity\";",
                  "+import { TranscriptMessage } from \"./TranscriptMessage\";"
                ].join("\n"),
                additions: 2,
                removals: 1
              }
            }
          ]
        },
        {
          type: "message",
          id: "item-6",
          role: "assistant",
          text: "The desktop shell is live and listing Codex threads.",
          createdAt: 1_763_500_100_000
        }
      ],
      messages: [
        {
          id: "item-1",
          role: "user",
          text: "Show me the current desktop thread shell",
          createdAt: undefined
        },
        {
          id: "item-2",
          role: "assistant",
          text: "I’m tracing the transcript scroll container.",
          createdAt: undefined
        },
        {
          id: "item-6",
          role: "assistant",
          text: "The desktop shell is live and listing Codex threads.",
          createdAt: undefined
        }
      ],
      lastUserMessage: "Show me the current desktop thread shell",
      lastAssistantMessage: "The desktop shell is live and listing Codex threads.",
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false,
        previousCursor: undefined
      }
    });

    await client.close();
  });

  it("normalizes skills/list results for composer autocomplete", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const skills = await client.listSkills({
      cwds: ["/Users/huntharo/pwrdrvr/PwrAgnt"],
    });

    expect(skills).toEqual([
      {
        cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
        skills: [
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            shortDescription: "Renderer UI design workflow.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            scope: "user",
            enabled: true,
          },
        ],
      },
    ]);

    await client.close();
  });

  it("extracts thread ids from nested thread results when creating a thread", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const created = await client.startThread({
      cwd: "/Users/huntharo/.pwragnt/projects/2026-04-16-ab12cd"
    });

    expect(created).toEqual({
      threadId: "thread-3"
    });

    await client.close();
  });

  it("treats unmaterialized new threads as empty transcripts", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.readThreadErrorByThreadId.set("thread-empty", {
      code: -32600,
      message:
        "thread 019d9901-ad06-7173-8df9-cd35c38d42ff is not materialized yet; includeTurns is unavailable before first user message"
    });

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-empty"
    });

    expect(replay).toEqual({
      entries: [],
      messages: [],
      pagination: {
        supportsPagination: false,
        hasPreviousPage: false
      }
    });

    await client.close();
  });

  it("best-effort resumes an existing thread before starting a turn", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const result = await client.startTurn({
      threadId: "thread-2",
      input: [{ type: "text", text: "Reply to the existing thread" }],
      model: "gpt-5.4"
    });

    expect(result).toEqual({
      threadId: "thread-2",
      runId: "turn-1"
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    const rpcMethods = transport!.sentMessages.map((message) => {
      const payload = JSON.parse(message) as { method?: string };
      return payload.method;
    });

    expect(rpcMethods).toContain("thread/resume");
    expect(rpcMethods).toContain("turn/start");

    const resumeIndex = rpcMethods.indexOf("thread/resume");
    const startIndex = rpcMethods.indexOf("turn/start");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(resumeIndex);

    await client.close();
  });

  it("falls back to the requested thread and a pending run id when turn/start omits ids", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.turnStartResult = {};

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const result = await client.startTurn({
      threadId: "thread-2",
      input: [{ type: "text", text: "Reply even if turn/start omits ids" }],
      model: "gpt-5.4"
    });

    expect(result).toEqual({
      threadId: "thread-2",
      runId: "pending:thread-2"
    });

    await client.close();
  });

  it("best-effort resumes an existing thread before interrupting a turn", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const result = await client.interruptTurn({
      threadId: "thread-2",
      runId: "turn-1"
    });

    expect(result).toEqual({
      threadId: "thread-2",
      runId: "turn-1"
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    const rpcMethods = transport!.sentMessages.map((message) => {
      const payload = JSON.parse(message) as { method?: string };
      return payload.method;
    });

    expect(rpcMethods).toContain("thread/resume");
    expect(rpcMethods).toContain("turn/interrupt");

    const resumeIndex = rpcMethods.indexOf("thread/resume");
    const interruptIndex = rpcMethods.indexOf("turn/interrupt");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(interruptIndex).toBeGreaterThan(resumeIndex);

    await client.close();
  });

  it("treats turn/interrupt timeouts as a best-effort success", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.turnInterruptResponseMode = "timeout";

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => [],
      requestTimeoutMs: 10
    });

    await expect(
      client.interruptTurn({
        threadId: "thread-2",
        runId: "turn-1"
      })
    ).resolves.toEqual({
      threadId: "thread-2",
      runId: "turn-1"
    });

    await client.close();
  });
});
