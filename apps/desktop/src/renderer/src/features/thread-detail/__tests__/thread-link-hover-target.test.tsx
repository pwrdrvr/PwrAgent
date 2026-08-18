import "@testing-library/jest-dom/vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ThreadRow } from "../../navigation/ThreadRow";
import { ThreadHeader } from "../ThreadHeader";
import { ThreadMarkdown } from "../ThreadMarkdown";

// Hovering (or focusing) a thread link anywhere in the window lights up the
// sidebar card it points at, in the same solid-accent treatment a sub-thread
// composer gives its source card. The link chip and the header title-bar link
// both write to one hover store on the thread-link context; `ThreadRow` reads
// it per row. These tests render both ends under one provider, the way the
// app shell does, and assert on the row's class — the same hook the CSS keys
// on.

const TARGET_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";
const OTHER_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c304";

function threadSummary(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: TARGET_THREAD_ID,
    title: "RELATED query deranking issue",
    titleSource: "generated",
    source: "codex",
    linkedDirectories: [],
    inbox: { unread: false },
    ...overrides,
  } as NavigationThreadSummary;
}

const targetThread = threadSummary();
const otherThread = threadSummary({
  id: OTHER_THREAD_ID,
  title: "Unrelated thread",
});

function rowFor(thread: NavigationThreadSummary) {
  return (
    <ThreadRow
      thread={thread}
      onOpenContextMenu={vi.fn()}
      onSelectThread={vi.fn()}
      onSetReaction={vi.fn(async () => undefined)}
      onUnbindMessagingBinding={vi.fn(async () => undefined)}
    />
  );
}

function rowElement(title: string): HTMLElement {
  const row = screen
    .getByRole("button", { name: new RegExp(`^${title}`) })
    .closest(".thread-row");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no .thread-row for ${title}`);
  }
  return row;
}

function renderChipAndRows(text: string, threads = [targetThread, otherThread]) {
  return render(
    <ThreadLinkProvider onShowThread={vi.fn()} threads={threads}>
      <ThreadMarkdown text={text} />
      <div className="sidebar">
        {threads.map((thread) => (
          <div key={thread.id}>{rowFor(thread)}</div>
        ))}
      </div>
    </ThreadLinkProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("thread link hover target", () => {
  it("lights up the linked thread's card while a chip is hovered, and only that card", () => {
    renderChipAndRows(`See [handoff](pwragent://thread/${TARGET_THREAD_ID})`);
    const chip = screen.getByRole("button", {
      name: "Open thread RELATED query deranking issue",
    });
    const targetRow = rowElement("RELATED query deranking issue");
    const otherRow = rowElement("Unrelated thread");

    expect(targetRow).not.toHaveClass("is-link-target");

    fireEvent.mouseEnter(chip);
    expect(targetRow).toHaveClass("is-link-target");
    expect(otherRow).not.toHaveClass("is-link-target");

    fireEvent.mouseLeave(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("follows keyboard focus the same way as the pointer", () => {
    renderChipAndRows(`See [handoff](pwragent://thread/${TARGET_THREAD_ID})`);
    const chip = screen.getByRole("button", {
      name: "Open thread RELATED query deranking issue",
    });
    const targetRow = rowElement("RELATED query deranking issue");

    fireEvent.focus(chip);
    expect(targetRow).toHaveClass("is-link-target");

    fireEvent.blur(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("releases the highlight when the chip is activated", () => {
    renderChipAndRows(`See [handoff](pwragent://thread/${TARGET_THREAD_ID})`);
    const chip = screen.getByRole("button", {
      name: "Open thread RELATED query deranking issue",
    });
    const targetRow = rowElement("RELATED query deranking issue");

    fireEvent.mouseEnter(chip);
    expect(targetRow).toHaveClass("is-link-target");

    fireEvent.click(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("releases the highlight when a hovered chip unmounts without a mouseleave", () => {
    const view = renderChipAndRows(`See [handoff](pwragent://thread/${TARGET_THREAD_ID})`);
    const chip = screen.getByRole("button", {
      name: "Open thread RELATED query deranking issue",
    });
    fireEvent.mouseEnter(chip);
    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");

    // Same provider, chip gone: the message re-rendered under the pointer.
    view.rerender(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[targetThread, otherThread]}>
        <ThreadMarkdown text="no link any more" />
        <div className="sidebar">
          <div>{rowFor(targetThread)}</div>
          <div>{rowFor(otherThread)}</div>
        </div>
      </ThreadLinkProvider>,
    );

    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
  });

  it("lights up the selected thread's card from the title-bar thread link", () => {
    render(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[targetThread, otherThread]}>
        <ThreadHeader
          thread={targetThread}
          onRevealSelectedThreadInList={vi.fn()}
        />
        <div className="sidebar">
          <div>{rowFor(targetThread)}</div>
          <div>{rowFor(otherThread)}</div>
        </div>
      </ThreadLinkProvider>,
    );
    const titleLink = screen.getByRole("button", {
      name: "Show selected thread in thread list",
    });
    const targetRow = rowElement("RELATED query deranking issue");
    const otherRow = rowElement("Unrelated thread");

    fireEvent.mouseEnter(titleLink);
    expect(targetRow).toHaveClass("is-link-target");
    expect(otherRow).not.toHaveClass("is-link-target");

    fireEvent.mouseLeave(titleLink);
    expect(targetRow).not.toHaveClass("is-link-target");

    fireEvent.focus(titleLink);
    expect(targetRow).toHaveClass("is-link-target");
    fireEvent.blur(titleLink);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("drops the previous thread's highlight when the header switches threads under the pointer", () => {
    const view = render(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[targetThread, otherThread]}>
        <ThreadHeader thread={targetThread} onRevealSelectedThreadInList={vi.fn()} />
        <div>{rowFor(targetThread)}</div>
        <div>{rowFor(otherThread)}</div>
      </ThreadLinkProvider>,
    );
    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "Show selected thread in thread list" }),
    );
    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");

    view.rerender(
      <ThreadLinkProvider onShowThread={vi.fn()} threads={[targetThread, otherThread]}>
        <ThreadHeader thread={otherThread} onRevealSelectedThreadInList={vi.fn()} />
        <div>{rowFor(targetThread)}</div>
        <div>{rowFor(otherThread)}</div>
      </ThreadLinkProvider>,
    );

    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
    expect(rowElement("Unrelated thread")).not.toHaveClass("is-link-target");
  });

  it("is inert outside a ThreadLinkProvider", () => {
    render(
      <>
        <ThreadHeader thread={targetThread} onRevealSelectedThreadInList={vi.fn()} />
        <div>{rowFor(targetThread)}</div>
      </>,
    );
    const titleLink = screen.getByRole("button", {
      name: "Show selected thread in thread list",
    });
    expect(() => fireEvent.mouseEnter(titleLink)).not.toThrow();
    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
  });
});
