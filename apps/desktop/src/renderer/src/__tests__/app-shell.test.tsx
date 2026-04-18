import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

describe("App", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the live thread shell with transcript history", async () => {
    const copyText = vi.fn(async () => undefined);
    const interruptTurn = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      runId: "turn-1",
    }));
    let readThreadCalls = 0;
    let resolveRefreshRead:
      | ((value: {
          backend: "codex";
          fetchedAt: number;
          threadId: string;
          replay: {
            entries: Array<Record<string, unknown>>;
            messages: Array<Record<string, unknown>>;
            lastUserMessage?: string;
            lastAssistantMessage?: string;
            pagination: {
              supportsPagination: boolean;
              hasPreviousPage: boolean;
            };
          };
        }) => void)
      | undefined;

    const transcriptResponse = {
      backend: "codex" as const,
      fetchedAt: Date.now(),
      threadId: "thread-1",
      replay: {
        entries: [
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files, ran 1 command",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read ThreadView.tsx"
              },
              {
                id: "detail-3",
                kind: "command",
                label: "pwd && rg --files"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        messages: [
          {
            id: "message-1",
            role: "user",
            text: "Open the desktop plan and build the Codex client."
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The Codex client is wired and the thread browser is live."
          }
        ],
        lastUserMessage: "Open the desktop plan and build the Codex client.",
        lastAssistantMessage:
          "The Codex client is wired and the thread browser is live.",
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false
        }
      }
    };

    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        copyText,
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: [
            {
              cwd: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
              skills: [
                {
                  name: "frontend-design",
                  description: "Design and verify renderer UI work.",
                  path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
                  enabled: true
                }
              ]
            }
          ]
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "skills/list", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["codex:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Build Codex client",
              titleSource: "explicit",
              summary: "Wire the app-server transport and list threads",
              source: "codex",
              executionMode: "default",
              gitBranch: "codex/build-codex-client",
              linkedDirectories: [
                {
                  id: "/Users/huntharo/pwrdrvr/PwrAgnt",
                  label: "PwrAgnt",
                  path: "/Users/huntharo/pwrdrvr/PwrAgnt",
                  worktreePath: "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt",
                  kind: "worktree"
                }
              ],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "codex",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onWindowFocus: () => () => undefined,
        readThread: async () => {
          readThreadCalls += 1;
          if (readThreadCalls === 1) {
            return transcriptResponse;
          }

          return await new Promise((resolve) => {
            resolveRefreshRead = resolve;
          });
        },
        platform: "darwin",
        startTurn: async () => ({
          backend: "codex",
          threadId: "thread-1",
          runId: "turn-1"
        }),
        interruptTurn,
        onAgentEvent: () => () => undefined,
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "Threads" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Inbox" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "recents" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Refresh threads" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Build Codex client"
      })
    ).toBeInTheDocument();
    const inboxHeading = screen.getByRole("heading", { level: 2, name: "Inbox" });
    const inboxSection = inboxHeading.closest("section");
    expect(inboxSection).not.toBeNull();
    expect(within(inboxSection as HTMLElement).getByText("1")).toBeInTheDocument();
    expect(screen.getAllByText("PwrAgnt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("codex/build-codex-client").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { level: 3, name: "Transcript" })).toBeInTheDocument();
    expect(
      await screen.findByText("Open the desktop plan and build the Codex client.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    expect(screen.getByText("Explored 2 files, ran 1 command")).toBeInTheDocument();
    const openContextButton = screen.getByRole("button", { name: "Open context rail" });
    openContextButton.click();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Thread details" })
    ).toBeInTheDocument();
    const context = screen.getByLabelText("Thread context");
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for PwrAgnt" })
    );
    fireEvent.click(
      within(context).getByRole("button", { name: "Copy path for worktree PwrAgnt" })
    );
    expect(copyText).toHaveBeenNthCalledWith(1, "/Users/huntharo/pwrdrvr/PwrAgnt");
    expect(copyText).toHaveBeenNthCalledWith(2, "/Users/huntharo/.codex/worktrees/0f38/PwrAgnt");
    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByText("darwin")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeEnabled();
    expect(
      screen.queryByText("This thread's backend is unavailable right now. You can keep drafting, but send is unavailable.")
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();

    const reply = screen.getByLabelText("Reply");
    fireEvent.change(reply, {
      target: { value: "$frontend-design what can this skill do" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(
        screen.getByText("what can this skill do").closest("article")
      ).toHaveClass("transcript-message--user");
    });
    expect(
      screen.getByText("The Codex client is wired and the thread browser is live.")
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Thinking");
    expect(screen.getByRole("status").querySelector(".thinking-scanner")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(
      screen.queryByText("Thinking", {
        selector: ".composer__meta"
      })
    ).not.toBeInTheDocument();
    expect(screen.getAllByText("$frontend-design").length).toBeGreaterThan(0);
    expect(screen.getByText("3 messages")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(interruptTurn).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
        runId: "turn-1",
      });
    });

    resolveRefreshRead?.(transcriptResponse);
  });

  it("creates and sends on a new Grok thread", async () => {
    const startThread = vi.fn(
      async ({
        backend,
        executionMode,
      }: {
        backend: "codex" | "grok";
        executionMode?: "default" | "full-access";
      }) => ({
        backend,
        threadId: "thread-2",
        executionMode: executionMode ?? "default",
      })
    );
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        runId: "turn-1"
      })
    );
    let navigationCallCount = 0;

    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read"],
              capabilities: {
                listThreads: true,
                createThread: false,
                resumeThread: true,
                readThread: true,
                startTurn: false,
                interruptTurn: false,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            },
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => {
          navigationCallCount += 1;

          if (navigationCallCount < 2) {
            return {
              backend: "all",
              fetchedAt: Date.now(),
              unchanged: false,
              inboxThreadKeys: ["codex:thread-1"],
              threads: [
                {
                  id: "thread-1",
                  title: "Build Codex client",
                  titleSource: "explicit",
                  summary: "Wire the app-server transport and list threads",
                  source: "codex",
                  executionMode: "default",
                  gitBranch: "codex/build-codex-client",
                  linkedDirectories: [],
                  inbox: {
                    inInbox: true,
                    reason: "new-thread"
                  },
                  updatedAt: Date.now()
                }
              ]
            };
          }

          return {
            backend: "all",
            fetchedAt: Date.now(),
            unchanged: false,
            inboxThreadKeys: ["grok:thread-2"],
            threads: [
              {
                id: "thread-2",
                title: "Investigate Grok thread",
                titleSource: "explicit",
                summary: "Start a new thread on Grok",
                source: "grok",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: true,
                  reason: "new-thread"
                },
                updatedAt: Date.now()
              },
              {
                id: "thread-1",
                title: "Build Codex client",
                titleSource: "explicit",
                summary: "Wire the app-server transport and list threads",
                source: "codex",
                executionMode: "default",
                linkedDirectories: [],
                inbox: {
                  inInbox: false
                },
                updatedAt: Date.now() - 1000
              }
            ]
          };
        },
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => {
          const userText =
            backend === "grok"
              ? "Start a Grok-backed thread from the sidebar."
              : "Open the desktop plan and build the Codex client.";
          const assistantText =
            backend === "grok"
              ? "The Grok thread is live and selected."
              : "The Codex client is wired and the thread browser is live.";

          return {
            backend,
            fetchedAt: Date.now(),
            threadId,
            replay: {
              entries: [
                {
                  type: "message",
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  type: "activity",
                  id: "activity-1",
                  summary: "Explored 2 files, ran 1 command",
                  details: []
                },
                {
                  type: "message",
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              messages: [
                {
                  id: "message-1",
                  role: "user",
                  text: userText
                },
                {
                  id: "message-2",
                  role: "assistant",
                  text: assistantText
                }
              ],
              pagination: {
                supportsPagination: false,
                hasPreviousPage: false
              }
            }
          };
        },
        startThread,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Build Codex client"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create thread with Grok in Default Access",
      })
    );

    expect(startThread).toHaveBeenCalledWith({ backend: "grok", executionMode: "default" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Investigate Grok thread" })
    ).toBeInTheDocument();
    expect(screen.getAllByText("Grok").length).toBeGreaterThan(0);
    expect(
      await screen.findByText("The Grok thread is live and selected.")
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: {
        value: "Can you check the plugin sdk boundary?"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(startTurn).toHaveBeenCalledWith({
      backend: "grok",
      threadId: "thread-2",
      input: [{ type: "text", text: "Can you check the plugin sdk boundary?" }]
    });
  });

  it("keeps assistant response text out of the thread header", async () => {
    const response =
      'I don\'t have a built-in "X Search" tool or direct real-time access to the X/Twitter API with the available workspace tools.';

    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listSkills: async () => ({
          backend: "codex",
          fetchedAt: Date.now(),
          data: []
        }),
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "grok",
              label: "Grok app server",
              available: true,
              methods: ["thread/list", "thread/read", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: true,
                transcriptPagination: false,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: false
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => ({
          backend: "all",
          fetchedAt: Date.now(),
          unchanged: false,
          inboxThreadKeys: ["grok:thread-1"],
          threads: [
            {
              id: "thread-1",
              title: "Use X Search to find stats on huntharo's latest tweets for me",
              titleSource: "explicit",
              summary: response,
              source: "grok",
              executionMode: "default",
              linkedDirectories: [],
              inbox: {
                inInbox: true,
                reason: "new-thread"
              },
              updatedAt: Date.now()
            }
          ]
        }),
        markThreadSeen: async () => ({
          backend: "grok",
          threadId: "thread-1",
          seenAt: Date.now()
        }),
        onAgentEvent: () => () => undefined,
        onWindowFocus: () => () => undefined,
        readThread: async () => ({
          backend: "grok",
          fetchedAt: Date.now(),
          threadId: "thread-1",
          replay: {
            entries: [
              {
                type: "message",
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on huntharo's latest tweets for me"
              },
              {
                type: "message",
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            messages: [
              {
                id: "message-1",
                role: "user",
                text: "Use X Search to find stats on huntharo's latest tweets for me"
              },
              {
                id: "message-2",
                role: "assistant",
                text: response
              }
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        platform: "darwin",
        startTurn: async () => ({
          backend: "grok",
          threadId: "thread-1",
          runId: "turn-1"
        }),
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "Use X Search to find stats on huntharo's latest tweets for me"
      })
    ).toBeInTheDocument();

    const transcript = screen.getByRole("region", { name: "Transcript" });

    expect(within(transcript).getByText(response)).toBeInTheDocument();
    expect(screen.getAllByText(response)).toHaveLength(1);
  });

  it("keeps a newly created Codex thread selected when thread/list lags behind creation", async () => {
    const startThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new",
      executionMode: "default" as const,
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: "codex" | "grok";
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: any = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        runId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true,
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true,
                },
              ],
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: "codex" | "grok";
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        startThread,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access",
      })
    );

    expect(startThread).toHaveBeenCalledWith({ backend: "codex", executionMode: "default" });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Untitled thread" })
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: {
        value: "hello new codex thread"
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-new",
      input: [{ type: "text", text: "hello new codex thread" }]
    });

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      threads: [
        {
          id: "thread-new",
          title: "hello new codex thread",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        },
        ...navigationSnapshot.threads,
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              runId: "turn-1",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "hello new codex thread" })
      ).toBeInTheDocument();
    });
  });

  it("applies explicit thread names from thread/name/updated notifications", async () => {
    const startThread = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-new"
    }));
    const agentEventListeners = new Set<
      (event: {
        backend: "codex" | "grok";
        notification: {
          method: string;
          params: Record<string, unknown>;
        };
      }) => void
    >();
    let navigationSnapshot: any = {
      backend: "all" as const,
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-existing"],
      threads: [
        {
          id: "thread-existing",
          title: "Existing Codex thread",
          titleSource: "explicit" as const,
          summary: "Already in the list",
          source: "codex" as const,
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread" as const
          },
          updatedAt: Date.now()
        }
      ]
    };
    const startTurn = vi.fn(
      async ({
        backend,
        threadId
      }: {
        backend: "codex" | "grok";
        threadId: string;
      }) => ({
        backend,
        threadId,
        runId: "turn-1"
      })
    );

    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        ping: () => "pong",
        listBackends: async () => ({
          fetchedAt: Date.now(),
          backends: [
            {
              kind: "codex",
              label: "Codex app server",
              available: true,
              methods: ["thread/list", "thread/read", "thread/start", "turn/start"],
              capabilities: {
                listThreads: true,
                createThread: true,
                resumeThread: true,
                readThread: true,
                startTurn: true,
                interruptTurn: true,
                steerTurn: false,
                transcriptPagination: true,
                toolUse: false,
                approvalRequests: false,
                multiDirectoryThreads: true
              },
              executionModes: [
                {
                  mode: "default",
                  label: "Default Access",
                  available: true,
                  isDefault: true
                },
                {
                  mode: "full-access",
                  label: "Full Access",
                  available: true
                }
              ]
            }
          ]
        }),
        getNavigationSnapshot: async () => navigationSnapshot,
        markThreadSeen: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          threadId,
          seenAt: Date.now()
        }),
        onAgentEvent: (
          listener: (event: {
            backend: "codex" | "grok";
            notification: {
              method: string;
              params: Record<string, unknown>;
            };
          }) => void
        ) => {
          agentEventListeners.add(listener);
          return () => {
            agentEventListeners.delete(listener);
          };
        },
        onWindowFocus: () => () => undefined,
        readThread: async ({
          backend,
          threadId
        }: {
          backend: "codex" | "grok";
          threadId: string;
        }) => ({
          backend,
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false
            }
          }
        }),
        startThread,
        startTurn,
        platform: "darwin",
        versions: {
          electron: "41.2.1"
        }
      }
    });

    render(<App />);

    await screen.findByRole("heading", {
      level: 2,
      name: "Existing Codex thread"
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Create thread with Codex in Default Access"
      })
    );

    fireEvent.change(screen.getByLabelText("Reply"), {
      target: {
        value: "Name this thread something funny and spunky. Something about potatoes."
      }
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    navigationSnapshot = {
      backend: "all",
      fetchedAt: Date.now(),
      unchanged: false,
      inboxThreadKeys: ["codex:thread-new"],
      threads: [
        {
          id: "thread-new",
          title: "Name this thread something funny and spunky. Something about potatoes.",
          titleSource: "derived",
          summary: undefined,
          source: "codex",
          linkedDirectories: [],
          inbox: {
            inInbox: true,
            reason: "new-thread"
          },
          updatedAt: Date.now()
        }
      ]
    };

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-new",
              runId: "turn-1",
            },
          },
        });
      }
    });

    await screen.findByRole("heading", {
      level: 2,
      name: "Name this thread something funny and spunky. Something about potatoes."
    });

    await act(async () => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/name/updated",
            params: {
              threadId: "thread-new",
              threadName: "Spud up the thread",
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 2, name: "Spud up the thread" })
      ).toBeInTheDocument();
    });
  });
});
