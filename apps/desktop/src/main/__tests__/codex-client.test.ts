import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonRpcTransport } from "../codex-app-server/json-rpc";

class MockTransport implements JsonRpcTransport {
  static instances: MockTransport[] = [];
  static readThreadErrorByThreadId = new Map<string, { code: number; message: string }>();
  static readThreadResultByThreadId = new Map<string, unknown>();
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
  static threadArchiveResult: unknown = {
    thread: {
      id: "thread-2"
    }
  };
  static threadUnarchiveResult: unknown = {
    thread: {
      id: "thread-2"
    }
  };
  static threadNameSetResult: unknown = {
    thread: {
      id: "thread-2"
    }
  };
  static modelListResult: unknown = {
    data: []
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
        params?: {
          archived?: boolean;
          limit?: number;
          searchTerm?: string;
          query?: string;
          filter?: string;
          sortKey?: string;
          sourceKinds?: string[];
        };
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

      if (searchTerm === "updated-at-sort") {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              data: params.params?.archived
                ? []
                : params.params?.sortKey === "updated_at"
                  ? [
                      {
                        id: "thread-recent",
                        name: "Recent search-product thread",
                        updatedAt: 1_776_200_000,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                      },
                      {
                        id: "thread-borderline",
                        name: "Borderline search-product thread",
                        updatedAt: 1_772_510_658,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                      },
                    ]
                  : [
                      {
                        id: "thread-recent",
                        name: "Recent search-product thread",
                        updatedAt: 1_776_200_000,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                      },
                      {
                        id: "thread-stale-created-order",
                        name: "Stale created-order thread",
                        updatedAt: 1_772_251_018,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                      },
                    ]
            }
          })
        );
        return;
      }

      if (searchTerm === "search-product-parity") {
        const matchesCodexWindow =
          params.params?.limit === 50 &&
          params.params?.sortKey === "updated_at" &&
          JSON.stringify(params.params?.sourceKinds) === JSON.stringify(["cli", "vscode"]);

        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: {
              data: params.params?.archived
                ? []
                : matchesCodexWindow
                  ? [
                      {
                        id: "thread-projmgr",
                        name: "search-product ProjMgr",
                        updatedAt: 1_776_298_236,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
                        name: "Plan Slidev theme extraction",
                        updatedAt: 1_776_179_110,
                        cwd: "/Users/huntharo/.codex/worktrees/be87/search-product",
                        path: "/tmp/missing-worktree-rollout.jsonl",
                        gitInfo: {
                          branch: "codex/plan-slidev-theme-extraction",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "thread-deck",
                        name: "Create Project Manager deck",
                        updatedAt: 1_776_019_529,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                    ]
                  : [
                      {
                        id: "thread-projmgr",
                        name: "search-product ProjMgr",
                        updatedAt: 1_776_298_236,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
                        name: "Plan Slidev theme extraction",
                        updatedAt: 1_776_179_110,
                        cwd: "/Users/huntharo/.codex/worktrees/be87/search-product",
                        path: "/tmp/missing-worktree-rollout.jsonl",
                        gitInfo: {
                          branch: "codex/plan-slidev-theme-extraction",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "thread-deck",
                        name: "Create Project Manager deck",
                        updatedAt: 1_776_019_529,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "019cb1de-230c-71f1-a833-8880f2ea1a4a",
                        name: "is this thing on?",
                        updatedAt: 1_772_510_658,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
                      {
                        id: "019c9cc2-6ea3-7d40-817d-9590d9118bbd",
                        name: "Gather Reddit feedback screenshots",
                        updatedAt: 1_772_391_226,
                        cwd: "/Users/huntharo/GIPHY/search-product",
                        gitInfo: {
                          branch: "main",
                          originUrl: "git@github.com:Giphy/search-product.git",
                        },
                      },
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

    if (payload.method === "model/list") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.modelListResult,
        })
      );
      return;
    }

    if (payload.method === "thread/read") {
      const threadId = (JSON.parse(message) as { params?: { threadId?: string } }).params?.threadId;
      const readThreadError = threadId
        ? MockTransport.readThreadErrorByThreadId.get(threadId)
        : undefined;
      const readThreadResult = threadId
        ? MockTransport.readThreadResultByThreadId.get(threadId)
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

      if (readThreadResult) {
        this.messageHandler(
          JSON.stringify({
            jsonrpc: "2.0",
            id: payload.id,
            result: readThreadResult
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
                      phase: "final_answer",
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

    if (payload.method === "thread/archive") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.threadArchiveResult
        })
      );
      return;
    }

    if (payload.method === "thread/unarchive") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.threadUnarchiveResult
        })
      );
      return;
    }

    if (payload.method === "thread/name/set") {
      this.messageHandler(
        JSON.stringify({
          jsonrpc: "2.0",
          id: payload.id,
          result: MockTransport.threadNameSetResult
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

  emitInbound(payload: unknown): void {
    this.messageHandler(JSON.stringify(payload));
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
    MockTransport.readThreadResultByThreadId.clear();
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
    MockTransport.threadArchiveResult = {
      thread: {
        id: "thread-2"
      }
    };
    MockTransport.threadNameSetResult = {
      thread: {
        id: "thread-2"
      }
    };
    MockTransport.modelListResult = {
      data: []
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
            limit: 50,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
          }
        }),
        expect.objectContaining({
          params: {
            archived: true,
            limit: 50,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
          }
        })
      ])
    );

    await client.close();
  });

  it("filters Codex models to the supported picker set and orders them", async () => {
    MockTransport.modelListResult = {
      data: [
        {
          id: "gpt-5.2",
          displayName: "gpt-5.2",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.5",
          displayName: "gpt-5.5",
          current: true,
          supportsReasoning: true,
        },
        {
          id: "gpt-5.3-codex",
          displayName: "gpt-5.3-codex",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.5-pro",
          displayName: "GPT-5.5-Pro",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.4-mini",
          displayName: "GPT-5.4-Mini",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.3-codex-spark",
          displayName: "GPT-5.3-Codex-Spark",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.4",
          displayName: "GPT-5.4",
          supportsReasoning: true,
        },
        {
          id: "gpt-5.1-codex-max",
          displayName: "gpt-5.1-codex-max",
          supportsReasoning: true,
        },
      ],
    };

    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
    });

    await expect(client.listModels()).resolves.toEqual([
      {
        id: "gpt-5.5",
        label: "GPT-5.5",
        current: true,
        supportsReasoning: true,
      },
      {
        id: "gpt-5.4",
        label: "GPT-5.4",
        current: undefined,
        supportsReasoning: true,
      },
      {
        id: "gpt-5.4-mini",
        label: "GPT-5.4-Mini",
        current: undefined,
        supportsReasoning: true,
      },
      {
        id: "gpt-5.3-codex",
        label: "GPT-5.3-Codex",
        current: undefined,
        supportsReasoning: true,
      },
      {
        id: "gpt-5.3-codex-spark",
        label: "GPT-5.3-Codex-Spark",
        current: undefined,
        supportsReasoning: true,
      },
      {
        id: "gpt-5.2",
        label: "GPT-5.2",
        current: undefined,
        supportsReasoning: true,
      },
    ]);
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
            limit: 50,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
          }
        }),
        expect.objectContaining({
          params: {
            searchTerm: "web-app",
            archived: true,
            limit: 50,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
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

  it("does not read rollout metadata when codex cwd points at a removed worktree", async () => {
    vi.resetModules();
    const readFileMock = vi.fn(async () => {
      throw new Error("desktop codex client should not read rollout files");
    });
    vi.doMock("node:fs/promises", () => ({
      access: vi.fn(async (targetPath: string) => {
        if (targetPath === "/Users/huntharo/.codex/worktrees/be87/search-product") {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      }),
      readFile: readFileMock,
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
          projectKey: "/Users/huntharo/.codex/worktrees/be87/search-product",
          linkedDirectories: []
        })
      ]);
      expect(readFileMock).not.toHaveBeenCalled();

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

  it("requests updated-at sorted interactive threads so stale created-order entries do not leak into the first page", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => [],
    });

    const threads = await client.listThreads({ filter: "updated-at-sort" });

    expect(threads.map((thread) => thread.id)).toEqual([
      "thread-recent",
      "thread-borderline",
    ]);
    expect(threads.find((thread) => thread.id === "thread-stale-created-order")).toBeUndefined();

    const transport = MockTransport.instances.at(-1);
    const threadListRequests = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: Record<string, unknown> })
      .filter((payload) => payload.method === "thread/list");
    expect(threadListRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            searchTerm: "updated-at-sort",
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
          }),
        }),
      ]),
    );

    await client.close();
  });

  it("matches Codex Desktop search-product parity for stale roots and deleted worktrees", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      threadDirectoryEnricher: async (projectKey) => {
        if (projectKey === "/Users/huntharo/GIPHY/search-product") {
          return {
            linkedDirectories: [
              {
                id: "/Users/huntharo/GIPHY/search-product",
                label: "search-product",
                path: "/Users/huntharo/GIPHY/search-product",
                kind: "local",
              },
            ],
            observedGitBranch: "main",
          };
        }

        return {
          linkedDirectories: [],
        };
      },
    });

    const threads = await client.listThreads({ filter: "search-product-parity" });

    expect(threads.map((thread) => thread.id)).toEqual([
      "thread-projmgr",
      "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
      "thread-deck",
    ]);
    expect(threads.find((thread) => thread.id === "019cb1de-230c-71f1-a833-8880f2ea1a4a")).toBeUndefined();
    expect(threads.find((thread) => thread.id === "019c9cc2-6ea3-7d40-817d-9590d9118bbd")).toBeUndefined();
    expect(
      threads.find((thread) => thread.id === "019d88a2-0e0b-77f0-bfce-130ae8e37d8f")
    ).toMatchObject({
      projectKey: "/Users/huntharo/.codex/worktrees/be87/search-product",
      linkedDirectories: [
        {
          id: "/Users/huntharo/GIPHY/search-product",
          label: "search-product",
          path: "/Users/huntharo/GIPHY/search-product",
          worktreePath: "/Users/huntharo/.codex/worktrees/be87/search-product",
          kind: "worktree",
        },
      ],
    });

    const transport = MockTransport.instances.at(-1);
    const threadListRequests = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: Record<string, unknown> })
      .filter((payload) => payload.method === "thread/list");
    expect(threadListRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          params: expect.objectContaining({
            searchTerm: "search-product-parity",
            limit: 50,
            sortKey: "updated_at",
            sourceKinds: ["cli", "vscode"],
          }),
        }),
      ]),
    );

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

  it("surfaces the locally observed branch when protocol metadata omits the branch name", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      threadDirectoryEnricher: async (projectKey) => ({
        linkedDirectories: projectKey
          ? [
              {
                id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                label: "PwrAgnt",
                path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                worktreePath: projectKey,
                kind: "worktree",
              },
            ]
          : [],
        observedGitBranch: "main",
      }),
    });

    const threads = await client.listThreads();
    const thread = threads.find((entry) => entry.id === "thread-2");

    expect(thread).toMatchObject({
      id: "thread-2",
      gitBranch: "main",
      observedGitBranch: "main",
    });

    await client.close();
  });

  it("keeps the protocol branch when the observed branch drifts after branch creation", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      threadDirectoryEnricher: async (projectKey) => ({
        linkedDirectories: projectKey
          ? [
              {
                id: "/Users/huntharo/GIPHY/search-product",
                label: "search-product",
                path: "/Users/huntharo/GIPHY/search-product",
                worktreePath: projectKey,
                kind: "worktree",
              },
            ]
          : [],
        observedGitBranch: "fix/desktop-codex-live-tool-labels",
      }),
    });

    const threads = await client.listThreads({ filter: "search-product-parity" });
    const thread = threads.find((entry) => entry.id === "thread-projmgr");

    expect(thread).toMatchObject({
      id: "thread-projmgr",
      gitBranch: "main",
      observedGitBranch: "fix/desktop-codex-live-tool-labels",
    });

    await client.close();
  });

  it("shows HEAD for detached worktrees even when session metadata still names a source branch", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      threadDirectoryEnricher: async (projectKey) => ({
        linkedDirectories: projectKey
          ? [
              {
                id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                label: "PwrAgnt",
                path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                worktreePath: projectKey,
                kind: "worktree",
              },
            ]
          : [],
        observedGitBranch: "HEAD",
      }),
    });

    const threads = await client.listThreads({ filter: "search-product-parity" });
    const thread = threads.find(
      (entry) => entry.id === "019d88a2-0e0b-77f0-bfce-130ae8e37d8f"
    );

    expect(thread).toMatchObject({
      id: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
      gitBranch: "HEAD",
      observedGitBranch: "HEAD",
    });

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
    const turn = {
      id: "turn-1",
      startedAt: 1_763_500_100_000
    };

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
          ],
          turn
        },
        {
          type: "message",
          id: "item-2",
          role: "assistant",
          text: "I’m tracing the transcript scroll container.",
          createdAt: 1_763_500_100_000,
          phase: "commentary",
          turn
        },
        {
          type: "activity",
          id: "activity-item-3",
          summary: "Explored 1 file, Ran 1 command, Edited 1 file, +2, -1",
          createdAt: 1_763_500_100_000,
          status: "completed",
          turn,
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
          createdAt: 1_763_500_100_000,
          phase: "final",
          turn
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

  it("forwards pagination params when reading older Codex transcript pages", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.readThread({
      threadId: "thread-2",
      before: "cursor-before-1",
      limit: 25
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    const readRequest = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .find((message) => message.method === "thread/read");

    expect(readRequest?.params).toMatchObject({
      threadId: "thread-2",
      includeTurns: true,
      before: "cursor-before-1",
      limit: 25
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
    const turn = {
      id: "turn-images",
      startedAt: 1_763_500_150_000
    };

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
        ],
        turn
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
        ],
        turn
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

  it("extracts structured plan items from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.readThreadResultByThreadId.set("thread-plan-item", {
      thread: {
        turns: [
          {
            id: "turn-1",
            startedAt: 1_763_500_200,
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [{ type: "text", text: "Plan the desktop transcript work." }]
              },
              {
                type: "plan",
                id: "plan-1",
                explanation: "Keep the transcript contract stable.",
                markdown: "## Final plan\n\nShip the transcript renderer in small steps.",
                steps: [
                  { step: "Normalize replay", status: "completed" },
                  { step: "Render live plan progress", status: "inProgress" }
                ]
              }
            ]
          }
        ]
      }
    });

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-plan-item"
    });
    const turn = {
      id: "turn-1",
      startedAt: 1_763_500_200_000
    };

    expect(replay.entries).toEqual([
      {
        type: "message",
        id: "item-1",
        role: "user",
        text: "Plan the desktop transcript work.",
        createdAt: 1_763_500_200_000,
          parts: [
            {
              type: "text",
              text: "Plan the desktop transcript work."
            }
          ],
          turn
        },
      {
        type: "plan",
        id: "plan-1",
        createdAt: 1_763_500_200_000,
        explanation: "Keep the transcript contract stable.",
        markdown: "## Final plan\n\nShip the transcript renderer in small steps.",
        steps: [
          { step: "Normalize replay", status: "completed" },
          { step: "Render live plan progress", status: "in_progress" }
        ],
        turn
      }
    ]);

    await client.close();
  });

  it("normalizes generated in-progress activity statuses from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.readThreadResultByThreadId.set("thread-in-progress-tools", {
      thread: {
        turns: [
          {
            id: "turn-tools",
            status: "inProgress",
            startedAt: 1_763_500_210,
            items: [
              {
                type: "dynamicToolCall",
                id: "tool-1",
                tool: "search_web",
                arguments: {},
                status: "inProgress",
                contentItems: null,
                success: null,
                durationMs: null
              },
              {
                type: "mcpToolCall",
                id: "tool-2",
                server: "github",
                tool: "search_issues",
                arguments: {},
                status: "inProgress",
                result: null,
                error: null,
                durationMs: null
              }
            ]
          }
        ]
      }
    });

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-in-progress-tools"
    });

    expect(replay.entries).toEqual([
      {
        type: "activity",
        id: "activity-tool-1",
        summary: "Used 2 tools",
        createdAt: 1_763_500_210_000,
        status: "in_progress",
        turn: {
          id: "turn-tools",
          status: "in_progress",
          startedAt: 1_763_500_210_000
        },
        details: [
          {
            id: "tool-1",
            kind: "command",
            label: "search_web",
            status: "in_progress"
          },
          {
            id: "tool-2",
            kind: "command",
            label: "search_issues",
            status: "in_progress"
          }
        ]
      }
    ]);

    await client.close();
  });

  it("normalizes request_user_input requests from rpc envelope ids", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.getInitializeResult();

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.onRequest((request) => {
      requests.push(request as { method: string; params: Record<string, unknown> });
      return {
        answers: {
          breakfast: {
            answers: ["Bagels"]
          }
        }
      };
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    transport!.emitInbound({
      jsonrpc: "2.0",
      id: "rpc-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-2",
        turnId: "turn-7",
        itemId: "call-1",
        questions: [
          {
            id: "breakfast",
            header: "Breakfast",
            question: "What should we eat?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Bagels",
                description: "Good with cream cheese."
              }
            ]
          }
        ]
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual([
      {
        method: "item/tool/requestUserInput",
        params: expect.objectContaining({
          threadId: "thread-2",
          turnId: "turn-7",
          itemId: "call-1",
          requestId: "rpc-input-1",
          questions: expect.any(Array)
        })
      }
    ]);
    expect(
      transport!.sentMessages
        .map((message) => JSON.parse(message) as { id?: string; result?: unknown })
        .find((message) => message.id === "rpc-input-1")
    ).toEqual({
      jsonrpc: "2.0",
      id: "rpc-input-1",
      result: {
        answers: {
          breakfast: {
            answers: ["Bagels"]
          }
        }
      }
    });

    await client.close();
  });

  it("normalizes generated turn notifications before forwarding", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.getInitializeResult();

    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.onNotification((notification) => {
      notifications.push(
        notification as { method: string; params: Record<string, unknown> }
      );
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    transport!.emitInbound({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: {
        threadId: "thread-2",
        turn: {
          id: "turn-from-generated",
          status: "completed",
          items: [],
          error: null,
          startedAt: 1_763_500_300,
          completedAt: 1_763_500_360,
          durationMs: 60_000
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toEqual([
      {
        method: "turn/completed",
        params: expect.objectContaining({
          threadId: "thread-2",
          turnId: "turn-from-generated",
          turn: expect.objectContaining({
            id: "turn-from-generated",
            status: "completed"
          })
        })
      }
    ]);

    await client.close();
  });

  it("preserves tool metadata on live item notifications", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.getInitializeResult();

    const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.onNotification((notification) => {
      notifications.push(
        notification as { method: string; params: Record<string, unknown> }
      );
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    transport!.emitInbound({
      jsonrpc: "2.0",
      method: "item/started",
      params: {
        threadId: "thread-2",
        turnId: "turn-2",
        item: {
          id: "item-tool-1",
          type: "commandExecution",
          status: "inProgress",
          name: "write_stdin",
          arguments: "{\"session_id\":40500,\"chars\":\"\",\"yield_time_ms\":1000}",
        }
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(notifications).toEqual([
      {
        method: "item/started",
        params: expect.objectContaining({
          threadId: "thread-2",
          turnId: "turn-2",
          item: expect.objectContaining({
            id: "item-tool-1",
            type: "commandExecution",
            toolName: "write_stdin",
            arguments: {
              session_id: 40500,
              chars: "",
              yield_time_ms: 1000
            }
          })
        })
      }
    ]);

    await client.close();
  });

  it("extracts update_plan function calls from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.readThreadResultByThreadId.set("thread-plan-call", {
      thread: {
        turns: [
          {
            id: "turn-1",
            startedAt: 1_763_500_300,
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [{ type: "text", text: "Build the task list rendering." }]
              },
              {
                type: "function_call",
                id: "item-2",
                name: "update_plan",
                arguments: JSON.stringify({
                  explanation: "Track the desktop work in three steps.",
                  plan: [
                    { step: "Normalize replay", status: "pending" },
                    { step: "Render plan cards", status: "pending" },
                    { step: "Verify with tests", status: "pending" }
                  ]
                })
              }
            ]
          }
        ]
      }
    });

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-plan-call"
    });
    const turn = {
      id: "turn-1",
      startedAt: 1_763_500_300_000
    };

    expect(replay.entries).toEqual([
      {
        type: "message",
        id: "item-1",
        role: "user",
        text: "Build the task list rendering.",
        createdAt: 1_763_500_300_000,
          parts: [
            {
              type: "text",
              text: "Build the task list rendering."
            }
          ],
          turn
        },
      {
        type: "plan",
        id: "item-2",
        createdAt: 1_763_500_300_000,
        explanation: "Track the desktop work in three steps.",
        steps: [
          { step: "Normalize replay", status: "pending" },
          { step: "Render plan cards", status: "pending" },
          { step: "Verify with tests", status: "pending" }
        ],
        turn
      }
    ]);

    await client.close();
  });

  it("extracts wrapped update_plan response items from thread/read", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.readThreadResultByThreadId.set("thread-wrapped-plan-call", {
      thread: {
        turns: [
          {
            id: "turn-1",
            startedAt: 1_763_500_350,
            items: [
              {
                type: "userMessage",
                id: "item-1",
                content: [{ type: "text", text: "Trace the image preview bug." }]
              },
              {
                type: "response_item",
                id: "item-2",
                payload: {
                  type: "function_call",
                  name: "update_plan",
                  arguments: JSON.stringify({
                    explanation: "Verify the renderer path before changing it.",
                    plan: [
                      { step: "Read the replay normalizer", status: "completed" },
                      { step: "Inspect the renderer", status: "in_progress" },
                      { step: "Summarize the findings", status: "pending" }
                    ]
                  })
                }
              }
            ]
          }
        ]
      }
    });

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const replay = await client.readThread({
      threadId: "thread-wrapped-plan-call"
    });
    const turn = {
      id: "turn-1",
      startedAt: 1_763_500_350_000
    };

    expect(replay.entries).toEqual([
      {
        type: "message",
        id: "item-1",
        role: "user",
        text: "Trace the image preview bug.",
        createdAt: 1_763_500_350_000,
          parts: [
            {
              type: "text",
              text: "Trace the image preview bug."
            }
          ],
          turn
        },
      {
        type: "plan",
        id: "item-2",
        createdAt: 1_763_500_350_000,
        explanation: "Verify the renderer path before changing it.",
        steps: [
          { step: "Read the replay normalizer", status: "completed" },
          { step: "Inspect the renderer", status: "in_progress" },
          { step: "Summarize the findings", status: "pending" }
        ],
        turn
      }
    ]);

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

  it("adds materialized app-created Codex threads to the Codex session index", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pwragnt-session-index-"));
    const sessionIndexPath = path.join(tempDir, "session_index.jsonl");
    MockTransport.threadStartResult = {
      thread: {
        id: "019dd225-74fb-7a83-b4e4-5970680d9382",
        path: path.join(
          tempDir,
          "sessions/2026/04/27/rollout-2026-04-27T23-32-43-019dd225-74fb-7a83-b4e4-5970680d9382.jsonl"
        ),
        cwd: "/Users/huntharo/github/PwrAgnt/.worktrees/launchpad-pwragnt-main-moi2lzw4",
        preview: "",
        name: null,
        updatedAt: 1_777_347_163,
      },
      model: "gpt-5.5",
    };

    try {
      const { CodexAppServerClient } = await import("../codex-app-server/client");

      const client = new CodexAppServerClient({
        command: "codex",
        directoryResolver: async () => [],
        sessionIndexPath,
      });

      await client.startThread({
        cwd: "/Users/huntharo/github/PwrAgnt/.worktrees/launchpad-pwragnt-main-moi2lzw4",
      });
      await client.close();

      const indexLines = (await fs.readFile(sessionIndexPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(indexLines).toEqual([
        {
          id: "019dd225-74fb-7a83-b4e4-5970680d9382",
          source: "pwragnt",
          thread_name: "Untitled thread",
          updated_at: "2026-04-28T03:32:43.000Z",
        },
      ]);
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("archives threads through the Codex app server", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await expect(client.archiveThread({ threadId: "thread-2" })).resolves.toEqual({
      threadId: "thread-2",
    });

    const transport = MockTransport.instances.at(-1);
    const archiveRequest = transport?.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .find((message) => message.method === "thread/archive");

    expect(archiveRequest).toMatchObject({
      method: "thread/archive",
      params: {
        threadId: "thread-2",
      },
    });

    await client.close();
  });

  it("restores threads through the Codex app server", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await expect(client.restoreThread({ threadId: "thread-2" })).resolves.toEqual({
      threadId: "thread-2",
    });

    const transport = MockTransport.instances.at(-1);
    const restoreRequest = transport?.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .find((message) => message.method === "thread/unarchive");

    expect(restoreRequest).toMatchObject({
      method: "thread/unarchive",
      params: {
        threadId: "thread-2",
      },
    });

    await client.close();
  });

  it("renames threads through the Codex app server", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await expect(
      client.renameThread({
        threadId: "thread-2",
        name: "Renamed desktop shell",
      })
    ).resolves.toEqual({
      threadId: "thread-2",
    });

    const transport = MockTransport.instances.at(-1);
    const renameRequest = transport?.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .find((message) => message.method === "thread/name/set");

    expect(renameRequest).toMatchObject({
      method: "thread/name/set",
      params: {
        threadId: "thread-2",
        name: "Renamed desktop shell",
      },
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
      turnId: "turn-1"
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

  it("starts plan-mode turns with a collaboration mode payload", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.threadResumeResult = {
      thread: {
        id: "thread-2"
      },
      model: "gpt-5.4",
      reasoningEffort: "high"
    };

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const result = await client.startTurn({
      threadId: "thread-2",
      input: [{ type: "text", text: "Plan the fix" }],
      collaborationMode: {
        mode: "plan",
        settings: {
          developerInstructions: null
        }
      }
    });

    expect(result).toEqual({
      threadId: "thread-2",
      turnId: "turn-1"
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();
    const startPayload = transport!.sentMessages
      .map((message) => JSON.parse(message) as { method?: string; params?: unknown })
      .find((payload) => payload.method === "turn/start");

    expect(startPayload?.params).toMatchObject({
      threadId: "thread-2",
      input: [{ type: "text", text: "Plan the fix" }],
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "high",
          developer_instructions: null
        }
      }
    });

    await client.close();
  });

  it("falls back to the requested thread and a pending turn id when turn/start omits ids", async () => {
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
      turnId: "pending:thread-2"
    });

    await client.close();
  });

  it("normalizes legacy runId turn/start responses", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");
    MockTransport.turnStartResult = {
      threadId: "thread-2",
      runId: "turn-legacy"
    };

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    const result = await client.startTurn({
      threadId: "thread-2",
      input: [{ type: "text", text: "Reply with the legacy id" }],
      model: "gpt-5.4"
    });

    expect(result).toEqual({
      threadId: "thread-2",
      turnId: "turn-legacy"
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
      turnId: "turn-1"
    });

    expect(result).toEqual({
      threadId: "thread-2",
      turnId: "turn-1"
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
        turnId: "turn-1"
      })
    ).resolves.toEqual({
      threadId: "thread-2",
      turnId: "turn-1"
    });

    await client.close();
  });

  it("normalizes approval requests from rpc envelope ids and nested thread metadata", async () => {
    const { CodexAppServerClient } = await import("../codex-app-server/client");

    const client = new CodexAppServerClient({
      command: "codex",
      directoryResolver: async () => []
    });

    await client.getInitializeResult();

    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    client.onRequest((request) => {
      requests.push(request as { method: string; params: Record<string, unknown> });
      return { decision: "decline" };
    });

    const transport = MockTransport.instances.at(-1);
    expect(transport).toBeDefined();

    transport!.emitInbound({
      jsonrpc: "2.0",
      id: "rpc-approval-1",
      method: "turn/requestApproval",
      params: {
        thread: {
          id: "thread-2"
        },
        turn: {
          id: "turn-7"
        },
        reason: "command requires approval: npm view dive",
        command: "npm view dive"
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requests).toEqual([
      {
        method: "turn/requestApproval",
        params: expect.objectContaining({
          threadId: "thread-2",
          turnId: "turn-7",
          requestId: "rpc-approval-1",
          reason: "command requires approval: npm view dive",
          command: "npm view dive"
        })
      }
    ]);

    await client.close();
  });
});
