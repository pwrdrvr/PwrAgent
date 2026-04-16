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
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-1",
            role: "user",
            text: "Open [`ce:work`](/Users/huntharo/.codex/skills/ce-work/SKILL.md)\n\n- Check Unit 4\n- Keep Unit 3 isolated"
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live.\n\nRun `pnpm test -- --project desktop-renderer` next."
          }
        ]}
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

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(
      screen.queryByRole("button", { name: "Jump to latest message" })
    ).not.toBeInTheDocument();
  });

  it("anchors a freshly loaded transcript to the newest message", () => {
    render(
      <TranscriptList
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-1",
            role: "user",
            text: "Show me the current desktop thread shell"
          },
          {
            id: "message-2",
            role: "assistant",
            text: "The desktop shell is live and listing Codex threads."
          }
        ]}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(scrollToMock).toHaveBeenCalledWith({
      behavior: "auto",
      top: 480
    });
  });

  it("preserves the reader position when older messages are prepended", () => {
    const { rerender } = render(
      <TranscriptList
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
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
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-1",
            role: "assistant",
            text: "First message"
          },
          {
            id: "message-2",
            role: "user",
            text: "Second message"
          },
          {
            id: "message-3",
            role: "assistant",
            text: "Third message"
          }
        ]}
        threadId="thread-1"
        onLoadOlder={async () => undefined}
      />
    );

    expect(list.scrollTop).toBe(240);
  });

  it("shows the jump-to-latest control only when the newest message is below the viewport", () => {
    render(
      <TranscriptList
        loading={false}
        loadingMore={false}
        messages={[
          {
            id: "message-1",
            role: "user",
            text: "First message"
          },
          {
            id: "message-2",
            role: "assistant",
            text: "Second message"
          }
        ]}
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
