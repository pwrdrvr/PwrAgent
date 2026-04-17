import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptList } from "../TranscriptList";

describe("TranscriptList", () => {
  let scrollHeight = 480;
  let clientHeight = 240;
  let scrollToMock: ReturnType<typeof vi.fn>;

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
  });

  afterEach(() => {
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
            text: "Open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)\n\n- Check Unit 4\n- Keep Unit 3 isolated"
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

    expect(screen.getByRole("link", { name: "`ce:work`" })).toHaveAttribute(
      "href",
      "file:///Users/huntharo/.codex/skills/ce-work/SKILL.md"
    );
    expect(screen.getByText("Check Unit 4")).toBeInTheDocument();
    expect(screen.getByText("Keep Unit 3 isolated")).toBeInTheDocument();
    expect(screen.getByText("pnpm test -- --project desktop-renderer")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "`ce:work`" }).closest("article")
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
