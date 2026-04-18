import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerNotification } from "@pwragnt/shared";
import { ThreadView } from "../ThreadView";

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:expanded-transcript-image")
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn()
  });
});

describe("ThreadView", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a directory-less thread with transcript history and context", () => {
    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            available: false,
            methods: [],
            capabilities: {
              listThreads: false,
              createThread: false,
              resumeThread: false,
              readThread: false,
              startTurn: false,
              interruptTurn: false,
              steerTurn: false,
              transcriptPagination: false,
              toolUse: false,
              approvalRequests: false,
              multiDirectoryThreads: false
            },
            executionModes: [
              {
                mode: "default",
                label: "Default Access",
                available: false,
                isDefault: true,
                unavailableReason: "XAI_API_KEY is not set",
              },
            ],
            unavailableReason: "XAI_API_KEY is not set"
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            runId: "turn-1",
          }),
        }}
        fetchedAt={Date.now()}
        loading={false}
        loadingMore={false}
        messageCount={2}
        platform="darwin"
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          summary: "Inspect Codex thread/read output and normalize it for desktop.",
          source: "codex",
          executionMode: "default",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Inspect [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md)."
          },
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 2 files",
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
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop client now reads the full transcript."
          }
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={async () => undefined}
        skillLoading={false}
      />
    );

    expect(
      screen.getByRole("heading", { level: 2, name: "Plan the app-server protocol" })
    ).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open context rail" }));

    expect(screen.getByText("No linked directory")).toBeInTheDocument();
    expect(
      screen.getByText("The desktop client now reads the full transcript.")
    ).toBeInTheDocument();
    expect(screen.getByText("Explored 2 files")).toBeInTheDocument();
    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Thread details" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin context rail" })).toBeInTheDocument();
    expect(screen.getByText("Codex app server")).toBeInTheDocument();
    expect(screen.getByText("Grok app server")).toBeInTheDocument();
    expect(screen.getByLabelText("Reply")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("shows missing recorded working directory details and copies the thread id", async () => {
    const copyText = vi.fn(async () => undefined);
    Object.defineProperty(window, "pwragnt", {
      configurable: true,
      value: {
        copyText
      }
    });

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
            runId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "019d88a2-0e0b-77f0-bfce-130ae8e37d8f",
          title: "Plan Slidev theme extraction",
          titleSource: "explicit",
          source: "codex",
          projectKey: "/Users/huntharo/.codex/worktrees/be87/search-product",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            text: "The thread still loads."
          }
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={vi.fn(async () => undefined)}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open context rail" }));

    expect(screen.getByText("Recorded working directory is no longer available.")).toBeInTheDocument();
    expect(screen.getByText("search-product")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Copy thread id" }));

    expect(copyText).toHaveBeenCalledWith("019d88a2-0e0b-77f0-bfce-130ae8e37d8f");
  });

  it("opens transcript image previews in a lightbox and dismisses them with Escape", () => {
    const dataUrl = "data:image/png;base64,aGVsbG8=";

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-images",
            runId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-images",
          title: "Inspect image rendering",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-image-1",
            role: "user",
            text: "",
            parts: [
              {
                type: "image",
                url: dataUrl,
                alt: "Transcript screenshot"
              }
            ]
          }
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand transcript image 1" }));

    const dialog = screen.getByRole("dialog", { name: "Expanded transcript image" });
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByAltText("Transcript screenshot")).toHaveAttribute(
      "src",
      "blob:expanded-transcript-image"
    );

    fireEvent.keyDown(window, { key: "Escape" });

    expect(
      screen.queryByRole("dialog", { name: "Expanded transcript image" })
    ).not.toBeInTheDocument();
  });

  it("clears an expanded transcript image when the selected thread changes", () => {
    const viewProps = {
      addOptimisticUserMessage: (_text: string) => "optimistic-1",
      backends: [
        {
          kind: "codex" as const,
          label: "Codex app server",
          available: true,
          methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
              mode: "default" as const,
              label: "Default Access",
              available: true,
              isDefault: true,
            },
          ],
        }
      ],
      composerDisabled: false,
      desktopApi: {
        startTurn: async () => ({
          backend: "codex" as const,
          threadId: "thread-images",
          runId: "turn-1",
        }),
      },
      loading: false,
      loadingMore: false,
      messageCount: 1,
      skills: [],
      transcriptEntries: [
        {
          type: "message" as const,
          id: "message-image-1",
          role: "user" as const,
          text: "",
          parts: [
            {
              type: "image" as const,
              url: "file:///tmp/screenshot.png",
              alt: "Transcript screenshot"
            }
          ]
        }
      ],
      onLoadOlder: async () => undefined,
      removeOptimisticMessage: (_id: string) => undefined,
      onRefresh: async () => undefined,
    };

    const { rerender } = render(
      <ThreadView
        {...viewProps}
        selectedThread={{
          id: "thread-images",
          title: "Inspect image rendering",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Expand transcript image 1" }));
    expect(screen.getByRole("dialog", { name: "Expanded transcript image" })).toBeInTheDocument();

    rerender(
      <ThreadView
        {...viewProps}
        selectedThread={{
          id: "thread-next",
          title: "Another thread",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
      />
    );

    expect(
      screen.queryByRole("dialog", { name: "Expanded transcript image" })
    ).not.toBeInTheDocument();
  });

  it("renders live assistant commentary from item/agentMessage/delta notifications", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification:
            | {
                method: "item/agentMessage/delta";
                params: {
                  threadId: string;
                  itemId: string;
                  delta: string;
                };
              }
            | {
                method: "turn/completed";
                params: {
                  threadId: string;
                  runId: string;
                  turn: {
                    id: string;
                    status: "completed";
                    output: Array<{
                      type: "text";
                      text: string;
                    }>;
                  };
                };
              };
        }) => void)
      | undefined;

    render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            runId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={{
          id: "thread-2",
          title: "Plan the app-server protocol",
          titleSource: "explicit",
          source: "codex",
          updatedAt: Date.now(),
          linkedDirectories: [],
          inbox: {
            inInbox: false
          }
        }}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={vi.fn(async () => undefined)}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-2",
            itemId: "msg-1",
            delta: "I ran ",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-2",
            itemId: "msg-1",
            delta: "`npm view dive`",
          },
        },
      });
    });

    expect(screen.getByText("I ran")).toBeInTheDocument();
    expect(screen.getByText("npm view dive")).toBeInTheDocument();
    expect(screen.getByText("I ran").closest("article")).toHaveClass(
      "transcript-message--assistant"
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-2",
            runId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [
                {
                  type: "text",
                  text: "done",
                },
              ],
            },
          },
        },
      });
    });

    expect(screen.queryByText("I ran")).not.toBeInTheDocument();
  });

  it("renders live plan progress from turn/plan/updated and clears it once replay catches up", async () => {
    const selectedThread = {
      id: "thread-2",
      title: "Plan the app-server protocol",
      titleSource: "explicit" as const,
      source: "codex" as const,
      updatedAt: Date.now(),
      linkedDirectories: [],
      inbox: {
        inInbox: false
      }
    };
    const livePlan = {
      type: "plan" as const,
      id: "persisted-plan-1",
      explanation: "Track the desktop transcript work in three steps.",
      steps: [
        { step: "Normalize replay", status: "pending" as const },
        { step: "Render plan card", status: "pending" as const },
        { step: "Verify the thread view", status: "pending" as const }
      ]
    };
    let agentEventHandler:
      | ((event: {
          backend: "codex";
          notification: AppServerNotification;
        }) => void)
      | undefined;

    const { rerender } = render(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            runId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Render the task list."
          }
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={vi.fn(async () => undefined)}
      />
    );

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-2",
            runId: "turn-1",
            plan: {
              explanation: livePlan.explanation,
              steps: livePlan.steps
            }
          }
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-other",
            runId: "turn-2",
            plan: {
              explanation: "Ignore this other thread.",
              steps: [{ step: "Ignore", status: "completed" }]
            }
          }
        },
      });
    });

    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(screen.getByText("Normalize replay")).toBeInTheDocument();
    expect(screen.getByText("Render plan card")).toBeInTheDocument();
    expect(screen.getByText("Verify the thread view")).toBeInTheDocument();
    expect(screen.queryByText("Ignore this other thread.")).not.toBeInTheDocument();

    rerender(
      <ThreadView
        addOptimisticUserMessage={(_text) => "optimistic-1"}
        backends={[
          {
            kind: "codex",
            label: "Codex app server",
            available: true,
            methods: ["thread/list", "thread/read", "turn/start", "skills/list"],
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
            ],
          }
        ]}
        composerDisabled={false}
        desktopApi={{
          onAgentEvent: (callback) => {
            agentEventHandler = callback as typeof agentEventHandler;
            return () => undefined;
          },
          startTurn: async () => ({
            backend: "codex",
            threadId: "thread-2",
            runId: "turn-1",
          }),
        }}
        loading={false}
        loadingMore={false}
        messageCount={1}
        selectedThread={selectedThread}
        skills={[]}
        transcriptEntries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Render the task list."
          },
          livePlan
        ]}
        onLoadOlder={async () => undefined}
        removeOptimisticMessage={(_id) => undefined}
        onRefresh={vi.fn(async () => undefined)}
      />
    );

    expect(screen.getAllByText("0 out of 3 tasks completed")).toHaveLength(1);
  });
});
