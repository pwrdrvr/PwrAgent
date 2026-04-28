import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptList } from "../TranscriptList";

describe("TranscriptList", () => {
  let scrollHeight = 480;
  let clientHeight = 240;
  let scrollToMock: ReturnType<typeof vi.fn>;
  let createObjectURLMock: ReturnType<typeof vi.fn>;
  let revokeObjectURLMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    scrollHeight = 480;
    clientHeight = 240;
    scrollToMock = vi.fn(function scrollTo(
      this: HTMLElement,
      options?: number | ScrollToOptions,
      y?: number
    ) {
      if (typeof options === "number") {
        this.scrollTop = y ?? 0;
        return;
      }

      this.scrollTop = options?.top ?? 0;
    });

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return scrollHeight;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return clientHeight;
      }
    });

    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: scrollToMock
    });

    createObjectURLMock = vi.fn(() => "blob:transcript-image");
    revokeObjectURLMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURLMock
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURLMock
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("renders transcript history and exposes incremental history loading when available", () => {
    const loadOlder = vi.fn(async () => undefined);

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)\n\n- **Check Unit 4**\n- Keep Unit 3 isolated"
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
            text: "The desktop shell is live.\n\nRun `pnpm test -- --project desktop-renderer` next."
          }
        ]}
        loading={false}
        loadingMore={false}
        pagination={{
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1"
        }}
        threadId="thread-1"
        onLoadOlder={loadOlder}
      />
    );

    expect(screen.getByRole("link", { name: "ce:work" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    expect(screen.getByText("Check Unit 4", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("Keep Unit 3 isolated")).toBeInTheDocument();
    expect(screen.getByText("pnpm test -- --project desktop-renderer")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "ce:work" }).closest("article")
    ).toHaveClass("transcript-message--user");
    expect(
      screen.getByText("pnpm test -- --project desktop-renderer").closest("article")
    ).toHaveClass("transcript-message--assistant");
    expect(screen.getByText("Explored 2 files, ran 1 command")).toBeInTheDocument();
    expect(screen.queryByText("Read TranscriptList.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("Read ThreadView.tsx")).not.toBeInTheDocument();
    expect(screen.queryByText("pwd && rg --files")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: /Explored 2 files, ran 1 command/i })
    );

    expect(screen.getByText("Read TranscriptList.tsx")).toBeInTheDocument();
    expect(screen.getByText("Read ThreadView.tsx")).toBeInTheDocument();
    expect(screen.getByText("pwd && rg --files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" })
    ).not.toBeInTheDocument();
  });

  it("renders skill mentions as chips when present alongside markdown text", () => {
    const loadOlder = vi.fn(async () => undefined);

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Load [$frontend-design](/Users/huntharo/.codex/skills/frontend-design/SKILL.md) and **keep** the current styling."
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live and listing Codex threads."
          }
        ]}
        loading={false}
        loadingMore={false}
        pagination={{
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "cursor-1"
        }}
        skills={[
          {
            name: "frontend-design",
            description: "Design and verify renderer UI work.",
            path: "/Users/huntharo/.codex/skills/frontend-design/SKILL.md",
            enabled: true,
          },
        ]}
        threadId="thread-1"
        onLoadOlder={loadOlder}
      />
    );

    expect(screen.getByText("$frontend-design")).toBeInTheDocument();
    expect(screen.getByText("keep", { selector: "strong" })).toBeInTheDocument();
    expect(
      screen.getByText("$frontend-design").closest("article")
    ).toHaveClass("transcript-message--user");
  });

  it("renders inline image previews and opens them on demand", () => {
    const onOpenImage = vi.fn();
    const dataUrl = "data:image/png;base64,aGVsbG8=";
    const secondDataUrl = "data:image/png;base64,d29ybGQ=";

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Describe this image",
            parts: [
              {
                type: "text",
                text: "Describe this image"
              },
              {
                type: "image",
                url: dataUrl,
                alt: "Transcript screenshot"
              },
              {
                type: "image",
                url: secondDataUrl,
                alt: "Second transcript screenshot"
              }
            ]
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "",
            parts: [
              {
                type: "image",
                url: "https://example.com/thread-image.png",
                alt: "Assistant image"
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onOpenImage={onOpenImage}
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("Describe this image")).toBeInTheDocument();
    expect(screen.getByAltText("Transcript screenshot")).toHaveAttribute(
      "src",
      "blob:transcript-image"
    );
    expect(screen.getByAltText("Second transcript screenshot")).toHaveAttribute(
      "src",
      "blob:transcript-image"
    );
    expect(screen.getByAltText("Assistant image")).toBeInTheDocument();
    expect(createObjectURLMock).toHaveBeenCalledTimes(2);
    expect(
      screen.getByAltText("Transcript screenshot").closest(".transcript-message__image-grid")
    ).toBe(
      screen.getByAltText("Second transcript screenshot").closest(".transcript-message__image-grid")
    );

    fireEvent.click(screen.getByAltText("Transcript screenshot").closest("button")!);

    expect(onOpenImage).toHaveBeenCalledWith({
      type: "image",
      url: dataUrl,
      alt: "Transcript screenshot"
    });
  });

  it("renders pending status inside the transcript list", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "What can this skill do?"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingStatusText="Waiting for the app server…"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("status")).toHaveTextContent("Waiting for the app server…");
    expect(screen.getByRole("status").querySelector(".thinking-scanner")).not.toBeNull();
  });

  it("renders replayed plan progress inline in the transcript", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Show the desktop task list."
          },
          {
            type: "plan",
            id: "plan-1",
            explanation: "Keep the renderer and replay contract aligned.",
            markdown: "## Final plan\n\nUse the transcript plan renderer for durable output.",
            steps: [
              { step: "Normalize replay", status: "pending" },
              { step: "Render transcript plan card", status: "pending" },
              { step: "Verify with tests", status: "pending" }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("0 out of 3 tasks completed")).toBeInTheDocument();
    expect(
      screen.getByText("Keep the renderer and replay contract aligned.")
    ).toBeInTheDocument();
    expect(screen.getByText("Normalize replay")).toBeInTheDocument();
    expect(screen.getByText("Render transcript plan card")).toBeInTheDocument();
    expect(screen.getByText("Verify with tests")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final plan" })).toBeInTheDocument();
    expect(
      screen.getByText("Use the transcript plan renderer for durable output.")
    ).toBeInTheDocument();
    expect(screen.getAllByText("Pending")).toHaveLength(3);
  });

  it("renders a live assistant message before the turn is persisted", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Run npm view dive"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "pending-assistant-1",
          role: "assistant",
          text: "I ran `npm view dive`"
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByText("I ran")).toBeInTheDocument();
    expect(screen.getByText("npm view dive")).toBeInTheDocument();
    expect(screen.getByText("I ran").closest("article")).toHaveClass(
      "transcript-message--assistant"
    );
  });

  it("collapses completed assistant commentary before the final answer", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "First commentary.",
          },
          {
            type: "message",
            id: "commentary-2",
            role: "assistant",
            phase: "commentary",
            text: "Second commentary.",
          },
          {
            type: "message",
            id: "commentary-3",
            role: "assistant",
            phase: "commentary",
            text: "Third commentary.",
          },
          {
            type: "message",
            id: "final-1",
            role: "assistant",
            phase: "final",
            text: "Final answer.",
          },
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: "3 previous messages" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Final answer.")).toBeVisible();
    expect(screen.getByText("First commentary.")).not.toBeVisible();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("First commentary.")).toBeVisible();
    expect(screen.getByText("Second commentary.")).toBeVisible();
    expect(screen.getByText("Third commentary.")).toBeVisible();
  });

  it("keeps all active commentary messages visible", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "First commentary.",
          },
          {
            type: "message",
            id: "commentary-2",
            role: "assistant",
            phase: "commentary",
            text: "Second commentary.",
          },
          {
            type: "message",
            id: "commentary-3",
            role: "assistant",
            phase: "commentary",
            text: "Third commentary.",
          },
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "commentary-4",
          role: "assistant",
          phase: "commentary",
          text: "Fourth commentary.",
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.queryByRole("button", { name: /previous message/ })).not.toBeInTheDocument();
    expect(screen.getByText("First commentary.")).toBeVisible();
    expect(screen.getByText("Second commentary.")).toBeVisible();
    expect(screen.getByText("Third commentary.")).toBeVisible();
    expect(screen.getByText("Fourth commentary.")).toBeVisible();
  });

  it("renders a live activity entry before the turn is persisted", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the merge markers"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "pending-activity-1",
          summary: "Edited 1 file, +1, -2",
          details: [
            {
              id: "pending-detail-1",
              kind: "write",
              label: "Update useThreadSessionState.ts",
              path: "/repo/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
              fileDiff: {
                kind: "update",
                additions: 1,
                removals: 2,
                diff: [
                  "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                  "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
                  "@@ -1,3 +1,2 @@",
                  "-<<<<<<< HEAD",
                  "-function appendMessageEntries(",
                  "+function messageMatchesOptimisticEntry("
                ].join("\n")
              }
            }
          ]
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: /Edited 1 file, \+1, -2/i });
    expect(toggle).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(screen.getByText("Update useThreadSessionState.ts")).toBeInTheDocument();
    expect(screen.getAllByText("-2")[0]).toBeInTheDocument();
    expect(screen.getAllByText("+1")[0]).toBeInTheDocument();
    expect(screen.getByText("function messageMatchesOptimisticEntry(")).toBeInTheDocument();
  });

  it("keeps just-finished live tool activity visible when the final message arrives", async () => {
    const completedTurn = {
      id: "turn-1",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 72_000,
      durationMs: 71_000,
    };

    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Fix the transcript activity."
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Fixed.",
            turn: completedTurn,
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Used 2 tools",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n transcript activity"
            },
            {
              id: "tool-detail-2",
              kind: "read",
              label: "Read TranscriptList.tsx"
            }
          ],
          turn: completedTurn,
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Used 2 tools/i })).toBeVisible();
    });
  });

  it("anchors a freshly loaded transcript to the newest entry", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "Show me the current desktop thread shell"
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
            text: "The desktop shell is live and listing Codex threads."
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");

    expect(list.scrollTop).toBe(480);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("collapses activity details by default and toggles them inline", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "activity",
            id: "activity-1",
            summary: "Explored 3 files",
            details: [
              {
                id: "detail-1",
                kind: "read",
                label: "Read TranscriptActivity.tsx"
              },
              {
                id: "detail-2",
                kind: "read",
                label: "Read TranscriptList.tsx"
              },
              {
                id: "detail-3",
                kind: "command",
                label: "Searched transcript-activity"
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const toggle = screen.getByRole("button", { name: /Explored 3 files/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read TranscriptActivity.tsx")).not.toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read TranscriptActivity.tsx")).toBeInTheDocument();
    expect(screen.getByText("Read TranscriptList.tsx")).toBeInTheDocument();
    expect(screen.getByText("Searched transcript-activity")).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read TranscriptActivity.tsx")).not.toBeInTheDocument();
  });

  it("renders simple write diffs fully without zoom controls", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "activity",
            id: "activity-1",
            summary: "Edited 1 file",
            details: [
              {
                id: "detail-1",
                kind: "write",
                label: "Update TranscriptList.tsx",
                path: "/repo/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                fileDiff: {
                  kind: "update",
                  additions: 1,
                  removals: 1,
                  diff: [
                    "--- a/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                    "+++ b/apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
                    "@@ -10,6 +10,6 @@",
                    " export function TranscriptList() {",
                    "   const a = 1;",
                    "   const b = 2;",
                    "   const c = 3;",
                    "-  return a + b;",
                    "+  return a + b + c;",
                    " }"
                  ].join("\n")
                }
              }
            ]
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Edited 1 file/i }));

    expect(screen.getByText("Update TranscriptList.tsx")).toBeInTheDocument();
    expect(screen.getByText("const b = 2;")).toBeInTheDocument();
    expect(screen.getByText("const c = 3;")).toBeInTheDocument();
    expect(screen.queryByText("2 unmodified lines skipped")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Zoom in" })).not.toBeInTheDocument();
  });

  it("preserves the reader position when older messages are prepended", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            type: "message",
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);

    scrollHeight = 640;

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "assistant",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            type: "message",
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(240);
  });

  it("shows the jump-to-latest control only when the newest entry is below the viewport", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");

    expect(
      screen.queryByRole("button", { name: "Jump to latest message" })
    ).not.toBeInTheDocument();

    list.scrollTop = 0;
    fireEvent.scroll(list);

    expect(screen.getByRole("button", { name: "Jump to latest message" })).toBeInTheDocument();
  });

  it("uses smooth scrolling only for the explicit jump-to-latest action", () => {
    render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 0;
    fireEvent.scroll(list);
    scrollToMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));

    expect(scrollToMock).toHaveBeenCalledWith({
      behavior: "smooth",
      top: 480
    });
  });

  it("restores the previous viewport when switching back to a cached thread", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 72;
    fireEvent.scroll(list);

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-2-message-1",
            role: "user",
            text: "Thread two first message"
          },
          {
            type: "message",
            id: "thread-2-message-2",
            role: "assistant",
            text: "Thread two second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-2"
        onLoadOlder={async () => undefined}
      />
    );

    list.scrollTop = 18;
    fireEvent.scroll(list);

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(72);
  });

  it("does not re-arm auto-scroll while a cached transcript is refreshing", () => {
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 72;
    fireEvent.scroll(list);
    scrollToMock.mockClear();

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          }
        ]}
        loading={true}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    scrollHeight = 640;

    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "thread-1-message-1",
            role: "user",
            text: "Thread one first message"
          },
          {
            type: "message",
            id: "thread-1-message-2",
            role: "assistant",
            text: "Thread one second message"
          },
          {
            type: "message",
            id: "thread-1-message-3",
            role: "assistant",
            text: "Thread one third message"
          },
          {
            type: "message",
            id: "thread-1-message-4",
            role: "assistant",
            text: "Thread one fourth message"
          }
        ]}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(72);
    expect(scrollToMock).not.toHaveBeenCalled();
  });

  it("keeps following the bottom while a streamed turn grows in place", () => {
    const longEntries = Array.from({ length: 24 }, (_, index) => ({
      type: "message" as const,
      id: `history-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `History message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={longEntries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 480;
    fireEvent.scroll(list);

    scrollHeight = 840;
    const entriesWithUserPrompt = [
      ...longEntries,
      {
        type: "message" as const,
        id: "user-prompt-1",
        role: "user" as const,
        text: "Please continue from here."
      }
    ];
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(840);

    list.scrollTop = 600;
    fireEvent.scroll(list);
    scrollHeight = 980;
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Searched 12 files",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n scroll apps/desktop/src"
            }
          ]
        }}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-1",
          role: "assistant",
          phase: "commentary",
          text: "I found the transcript scroll handling."
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(980);

    list.scrollTop = 740;
    fireEvent.scroll(list);
    scrollHeight = 1120;
    rerender(
      <TranscriptList
        entries={entriesWithUserPrompt}
        loading={false}
        loadingMore={false}
        pendingActivityEntry={{
          type: "activity",
          id: "tool-usage-1",
          summary: "Searched 12 files and read 3 files",
          details: [
            {
              id: "tool-detail-1",
              kind: "command",
              label: "rg -n scroll apps/desktop/src"
            },
            {
              id: "tool-detail-2",
              kind: "read",
              label: "Read TranscriptList.tsx"
            }
          ]
        }}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-1",
          role: "assistant",
          phase: "commentary",
          text: [
            "I found the transcript scroll handling.",
            "The pending assistant message is still streaming, so the same message id grows taller.",
            "When the viewport was already pinned to the bottom, that growth should keep moving the viewport."
          ].join(" ")
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(1120);
  });

  it("keeps following after a new prompt is appended to a long bottom-pinned chat", () => {
    const entries = Array.from({ length: 32 }, (_, index) => ({
      type: "message" as const,
      id: `long-message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Long transcript message ${index + 1}`
    }));
    scrollHeight = 960;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 720;
    fireEvent.scroll(list);

    const entriesWithNextPrompt = [
      ...entries,
      {
        type: "message" as const,
        id: "user-prompt-2",
        role: "user" as const,
        text: "Add one more answer at the bottom."
      }
    ];
    scrollHeight = 1080;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(1080);

    list.scrollTop = 840;
    fireEvent.scroll(list);
    scrollHeight = 1200;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-2",
          role: "assistant",
          phase: "final",
          text: "Here is the beginning of the answer."
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );
    expect(list.scrollTop).toBe(1200);

    list.scrollTop = 960;
    fireEvent.scroll(list);
    scrollHeight = 1340;
    rerender(
      <TranscriptList
        entries={entriesWithNextPrompt}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-2",
          role: "assistant",
          phase: "final",
          text: [
            "Here is the beginning of the answer.",
            "More streamed content arrived after the prompt, and following mode should keep the latest line visible."
          ].join(" ")
        }}
        pendingStatusText="Thinking"
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(1340);
  });

  it("does not move the reader when new messages arrive below an older viewport", () => {
    const entries = Array.from({ length: 16 }, (_, index) => ({
      type: "message" as const,
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Message ${index + 1}`
    }));
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={entries}
        loading={false}
        loadingMore={false}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 96;
    fireEvent.scroll(list);

    scrollHeight = 920;
    rerender(
      <TranscriptList
        entries={[
          ...entries,
          {
            type: "message",
            id: "new-message-1",
            role: "assistant",
            text: "This arrived out of view."
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "new-message-2",
          role: "assistant",
          phase: "commentary",
          text: "This is still below the reader."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(96);
  });

  it("re-enters bottom-following mode after the jump-to-latest button is clicked", () => {
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-3",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);
    fireEvent.click(screen.getByRole("button", { name: "Jump to latest message" }));
    expect(scrollToMock).toHaveBeenLastCalledWith({
      behavior: "smooth",
      top: 720
    });

    list.scrollTop = 480;
    fireEvent.scroll(list);
    scrollHeight = 860;
    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-3",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts. More content arrives after the jump button re-entered following mode."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(860);
  });

  it("re-enters bottom-following mode after manually scrolling to the bottom", () => {
    scrollHeight = 720;
    const { rerender } = render(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-4",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    const list = screen.getByRole("list");
    list.scrollTop = 80;
    fireEvent.scroll(list);
    list.scrollTop = 480;
    fireEvent.scroll(list);

    scrollHeight = 860;
    rerender(
      <TranscriptList
        entries={[
          {
            type: "message",
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            type: "message",
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
        loading={false}
        loadingMore={false}
        pendingAssistantMessage={{
          type: "message",
          id: "assistant-stream-4",
          role: "assistant",
          phase: "commentary",
          text: "Streaming starts. Manual scrolling reached the bottom, so the next streamed chunk should stay visible."
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(860);
  });

  it("shows command approval reason and command when no prompt is provided", () => {
    const { container } = render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingRequest={{
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1",
            reason: "Network access is required.",
            command: "/bin/zsh -lc 'npm view dive'",
          },
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();
    expect(screen.getByText(/Network access is required/)).toBeInTheDocument();
    expect(screen.getByText("Command:")).toBeInTheDocument();
    expect(container.querySelector(".transcript-request pre code")).toHaveTextContent(
      "npm view dive"
    );
    expect(screen.queryByText(/\/bin\/zsh -lc/)).not.toBeInTheDocument();
  });

  it("prefers parsed command actions for command approval display", () => {
    const { container } = render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingRequest={{
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            requestId: "approval-1",
            reason: "Network access is required.",
            command: "/bin/zsh -lc 'npm view dive'",
            commandActions: [
              {
                type: "search",
                command: "npm view dive",
              },
            ],
          },
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending approval" })).toBeInTheDocument();
    expect(screen.getByText("Command:")).toBeInTheDocument();
    expect(container.querySelector(".transcript-request pre code")).toHaveTextContent(
      "npm view dive"
    );
    expect(screen.queryByText(/\/bin\/zsh -lc/)).not.toBeInTheDocument();
  });

  it("renders pending user input without approval actions", () => {
    render(
      <TranscriptList
        entries={[]}
        loading={false}
        loadingMore={false}
        pendingUserInput={{
          method: "item/tool/requestUserInput",
          threadId: "thread-1",
          requestId: "input-request-1",
          currentIndex: 0,
          answers: [null],
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "Which path should I take?",
              options: [
                {
                  key: "A",
                  label: "Small patch (Recommended)",
                  description: "Keep this scoped.",
                  recommended: true,
                },
              ],
              allowFreeform: false,
              secret: false,
            },
          ],
        }}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(screen.getByRole("group", { name: "Pending input" })).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Decline" })).not.toBeInTheDocument();
  });
});
