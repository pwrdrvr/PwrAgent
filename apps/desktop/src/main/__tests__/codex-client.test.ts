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
      const params = JSON.parse(message) as {
        params?: { archived?: boolean; searchTerm?: string; query?: string; filter?: string };
      };
      const searchTerm =
        params.params?.searchTerm ?? params.params?.query ?? params.params?.filter;

      if (searchTerm === "missing-worktree") {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              data: params.params?.archived
                ? []
                : [
                    {
                      id: "thread-missing-worktree",
                      name: "Investigate chunk file errors",
                      updatedAt: 1_776_000_000,
                      cwd: "/Users/huntharo/.codex/worktrees/0cb4/web-app",
                    }
                  ]
            }
          })
        );
        return;
      }

      if (searchTerm === "forked-worktree") {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              data: params.params?.archived
                ? []
                : [
                    {
                      id: "thread-forked-worktree",
                      name: "Plan Slidev theme extraction",
                      updatedAt: 1_776_100_000,
                      cwd: "/Users/huntharo/.codex/worktrees/be87/search-product",
                      path: "/tmp/forked-worktree-rollout.jsonl",
                    }
                  ]
            }
          })
        );
        return;
      }

      if (params.params?.archived === true) {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              data: [
                {
                  id: "thread-renamed",
                  name: "Spud up the thread",
                  preview:
                    "Name this thread something funny and spunky. Something about potatoes.",
                  updatedAt: 1_763_500_500,
                  cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
                },
                {
                  id: "thread-archive",
                  name: "Retired archived thread",
                  preview: "This one should not appear in the active navigation list.",
                  updatedAt: 1_763_500_250,
                  cwd: "/Users/huntharo/pwrdrvr/PwrAgnt",
                }
              ]
            }
          })
        );
        return;
      }

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
                preview:
                  "I need a bedtime story about Nvidia and building AI through programmable shaders as an accident.",
                text: "Do not leak this planning prompt into the thread browser",
                updatedAt: 1_763_400_000,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/openclaw-codex-app-server"
                }
              },
              {
                id: "thread-renamed",
                preview:
                  "Name this thread something funny and spunky. Something about potatoes.",
                updatedAt: 1_763_500_100,
                session: {
                  cwd: "/Users/huntharo/pwrdrvr/PwrAgnt"
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

      if (threadId === "thread-images") {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              thread: {
                turns: [
                  {
                    id: "turn-images",
                    startedAt: 1_763_500_150,
                    items: [
                      {
                        type: "userMessage",
                        id: "item-image-1",
                        content: [
                          {
                            type: "input_text",
                            text: "Describe this image"
                          },
                          {
                            type: "input_image",
                            image_url: "data:image/png;base64,aGVsbG8="
                          }
                        ]
                      },
                      {
                        type: "userMessage",
                        id: "item-image-2",
                        content: [
                          {
                            type: "input_image",
                            image_url: "https://example.com/thread-image.png",
                            alt: "Thread image"
                          }
                        ]
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
    const primaryThread = threads.find((thread) => thread.id === "thread-2");
    const derivedThread = threads.find((thread) => thread.id === "thread-1");
    const renamedThread = threads.find((thread) => thread.id === "thread-renamed");
    const archivedThread = threads.find((thread) => thread.id === "thread-archive");

    expect(threads).toHaveLength(3);
    expect(primaryThread).toMatchObject({
      id: "thread-2",
      title: "Ship desktop shell",
      titleSource: "explicit",
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
    expect(derivedThread?.title).toBe(
      "A bedtime story about Nvidia and building AI through programmable...",
    );
    expect(derivedThread?.titleSource).toBe("derived");
    expect(derivedThread?.summary).toBeUndefined();
    expect(renamedThread).toMatchObject({
      id: "thread-renamed",
      title: "Spud up the thread",
      titleSource: "explicit",
    });
    expect(archivedThread).toBeUndefined();

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    const threadListRequests = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .filter((payload) => payload.method === "thread/list");

    expect(threadListRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: {
            archived: false,
            limit: 100
          }
        }),
        expect.objectContaining({
          params: {
            archived: true,
            limit: 100
          }
        })
      ])
    );

    await client.close();
  });

  it("uses query payloads when filtering the codex thread list", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.listThreads({ filter: "web-app" });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    const threadListRequests = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .filter((payload) => payload.method === "thread/list");

    expect(threadListRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: {
            searchTerm: "web-app",
            archived: false,
            limit: 100
          }
        }),
        expect.objectContaining({
          params: {
            searchTerm: "web-app",
            archived: true,
            limit: 100
          }
        })
      ])
    );

    await client.close();
  });

  it("ignores missing worktree cwd paths when deriving linked directories", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (targetPath: string) => {
        if (targetPath === "/Users/huntharo/.codex/worktrees/0cb4/web-app") {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      })
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(
        (
          _file: string,
          _args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          callback(null, { stdout: "", stderr: "" });
        }
      )
    }));

    try {
      const { CodexAppServerClient } = await import("../codex-app-server/client");

      const client = new CodexAppServerClient({
        command: "codex"
      });

      const threads = await client.listThreads({ filter: "missing-worktree" });

      expect(threads).toEqual([
        expect.objectContaining({
          id: "thread-missing-worktree",
          projectKey: "/Users/huntharo/.codex/worktrees/0cb4/web-app",
          linkedDirectories: []
        })
      ]);

      await client.close();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("recovers the stable repo directory from rollout metadata when codex cwd is a removed worktree", async () => {
    vi.resetModules();
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (targetPath: string) => {
        if (targetPath === "/Users/huntharo/.codex/worktrees/be87/search-product") {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      }),
      readFile: vi.fn(async (targetPath: string) => {
        if (targetPath !== "/tmp/forked-worktree-rollout.jsonl") {
          throw new Error(`Unexpected read: ${targetPath}`);
        }

        return [
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "thread-forked-worktree",
              forked_from_id: "thread-parent",
              cwd: "/Users/huntharo/.codex/worktrees/be87/search-product"
            }
          }),
          JSON.stringify({
            type: "session_meta",
            payload: {
              id: "thread-parent",
              cwd: "/Users/huntharo/GIPHY/search-product"
            }
          })
        ].join("\n");
      })
    }));
    vi.doMock("node:child_process", () => ({
      execFile: vi.fn(
        (
          _file: string,
          args: string[],
          _options: unknown,
          callback: (error: Error | null, result?: { stdout: string; stderr: string }) => void
        ) => {
          if (args.includes("rev-parse")) {
            callback(null, {
              stdout: "/Users/huntharo/GIPHY/search-product\n",
              stderr: "",
            });
            return;
          }

          if (args.includes("worktree")) {
            callback(null, {
              stdout: "worktree /Users/huntharo/GIPHY/search-product\n",
              stderr: "",
            });
            return;
          }

          callback(new Error(`Unexpected git invocation: ${args.join(" ")}`));
        }
      )
    }));

    try {
      const { CodexAppServerClient } = await import("../codex-app-server/client");

      const client = new CodexAppServerClient({
        command: "codex"
      });

      const threads = await client.listThreads({ filter: "forked-worktree" });

      expect(threads).toEqual([
        expect.objectContaining({
          id: "thread-forked-worktree",
          projectKey: "/Users/huntharo/GIPHY/search-product",
          linkedDirectories: [
            {
              id: "/Users/huntharo/GIPHY/search-product",
              label: "search-product",
              path: "/Users/huntharo/GIPHY/search-product",
              kind: "local"
            }
          ]
        })
      ]);

      await client.close();
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.doUnmock("node:child_process");
      vi.resetModules();
    }
  });

  it("does not synthesize summaries from raw conversation text", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const threads = await client.listThreads();
    const derivedThread = threads.find((thread) => thread.id === "thread-1");

    expect(derivedThread?.summary).toBeUndefined();

    await client.close();
  });

  it("hydrates archived threads so persisted explicit names survive reload", async () => {
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
                kind: "local"
              }
            ]
          : []
    });

    const threads = await client.listThreads();

    expect(threads.find((thread) => thread.id === "thread-renamed")).toMatchObject({
      id: "thread-renamed",
      title: "Spud up the thread",
      titleSource: "explicit",
      source: "codex",
    });
    expect(threads.find((thread) => thread.id === "thread-archive")).toBeUndefined();

    const threadListRequests = MockTransport.instances[0]?.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: { archived?: boolean } })
      .filter((message) => message.method === "thread/list");
    expect(threadListRequests?.some((message) => message.params?.archived === false)).toBe(true);
    expect(threadListRequests?.some((message) => message.params?.archived === true)).toBe(true);

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
          createdAt: 1_763_500_100_000,
          parts: [
            {
              type: "text",
              text: "Show me the current desktop thread shell"
            }
          ]
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
          createdAt: undefined,
          parts: [
            {
              type: "text",
              text: "Show me the current desktop thread shell"
            }
          ]
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

  it("preserves image parts from Codex thread/read messages", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-images"
    });

    expect(replay.entries).toEqual([
      {
        type: "message",
        id: "item-image-1",
        role: "user",
        text: "Describe this image",
        createdAt: 1_763_500_150_000,
        parts: [
          {
            type: "text",
            text: "Describe this image"
          },
          {
            type: "image",
            url: "data:image/png;base64,aGVsbG8="
          }
        ]
      },
      {
        type: "message",
        id: "item-image-2",
        role: "user",
        text: "",
        createdAt: 1_763_500_150_000,
        parts: [
          {
            type: "image",
            url: "https://example.com/thread-image.png",
            alt: "Thread image"
          }
        ]
      }
    ]);
    expect(replay.messages).toEqual([
      {
        id: "item-image-1",
        role: "user",
        text: "Describe this image",
        createdAt: undefined,
        parts: [
          {
            type: "text",
            text: "Describe this image"
          },
          {
            type: "image",
            url: "data:image/png;base64,aGVsbG8="
          }
        ]
      },
      {
        id: "item-image-2",
        role: "user",
        text: "",
        createdAt: undefined,
        parts: [
          {
            type: "image",
            url: "https://example.com/thread-image.png",
            alt: "Thread image"
          }
        ]
      }
    ]);
    expect(replay.lastUserMessage).toBe("Describe this image");

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
