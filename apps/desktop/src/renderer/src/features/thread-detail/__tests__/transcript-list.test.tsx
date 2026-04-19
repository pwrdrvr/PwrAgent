import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

    expect(scrollToMock).toHaveBeenCalledWith({
      behavior: "auto",
      top: 480
    });
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
});
