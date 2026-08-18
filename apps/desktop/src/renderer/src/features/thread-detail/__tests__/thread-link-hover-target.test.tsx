import "@testing-library/jest-dom/vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ThreadRow } from "../../navigation/ThreadRow";
import { ThreadHeader } from "../ThreadHeader";
import { ThreadMarkdown } from "../ThreadMarkdown";

// Hovering (or keyboard-focusing) a thread link anywhere in the window lights
// up the sidebar card it points at, in the same solid-accent treatment a
// sub-thread composer gives its source card. The link chip and the header
// title-bar link both write to one owner-aware hover store on the thread-link
// context; `ThreadRow` reads it per row. These tests render both ends under
// one provider, the way the app shell does, and assert on the row's class —
// the same hook the CSS keys on.
//
// Focus is driven with real `.focus()` / `.blur()` rather than
// `fireEvent.focus`: the highlight only follows *visible* keyboard focus
// (`:focus-visible`), which jsdom resolves from `document.activeElement`
// once the focus dispatch has settled.

const TARGET_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";
const OTHER_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c304";
const REMOTE_INSTANCE_ID = "instance-remote-1";

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
const remoteThread = threadSummary({
  federation: {
    ref: {
      target: { scope: "remote", instanceId: REMOTE_INSTANCE_ID },
    },
    instanceLabel: "Peer",
  } as NavigationThreadSummary["federation"],
});

const TARGET_LINK = `[handoff](pwragent://thread/${TARGET_THREAD_ID})`;
const OTHER_LINK = `[other](pwragent://thread/${OTHER_THREAD_ID})`;
const CHIP_NAME = "Open thread RELATED query deranking issue";
const OTHER_CHIP_NAME = "Open thread Unrelated thread";
const TITLE_LINK_NAME = "Show selected thread in thread list";

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

/**
 * One provider wrapping the link sources under test and a sidebar of rows —
 * the shape the app shell has. `text` renders transcript chips; `headerThread`
 * renders the title-bar link for that thread. Rerender with a different
 * `headerThread` to model a thread switch under a resting pointer.
 */
function scene(options: {
  headerThread?: NavigationThreadSummary;
  text?: string;
  threads?: NavigationThreadSummary[];
}) {
  const threads = options.threads ?? [targetThread, otherThread];
  return (
    <ThreadLinkProvider onShowThread={vi.fn()} threads={threads}>
      {options.headerThread ? (
        <ThreadHeader
          thread={options.headerThread}
          onRevealSelectedThreadInList={vi.fn()}
        />
      ) : null}
      {options.text ? <ThreadMarkdown text={options.text} /> : null}
      <div className="sidebar">
        {threads.map((thread) => (
          <div key={thread.id}>{rowFor(thread)}</div>
        ))}
      </div>
    </ThreadLinkProvider>
  );
}

function renderScene(options: Parameters<typeof scene>[0]) {
  const view = render(scene(options));
  return {
    ...view,
    rerenderScene: (next: Parameters<typeof scene>[0]) => view.rerender(scene(next)),
  };
}

// Keyboard focus: a Tab keystroke followed by the focus move, which is what
// jsdom's `:focus-visible` emulation (like the browsers') keys on. The
// highlight reads `:focus-visible` a microtask after focus settles, so the
// move is awaited inside an async act.
async function focus(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    element.focus();
    await Promise.resolve();
  });
}

async function blur(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.blur();
  });
}

afterEach(() => {
  cleanup();
});

describe("thread link hover target", () => {
  it("lights up the linked thread's card while a chip is hovered, and only that card", () => {
    renderScene({ text: `See ${TARGET_LINK}` });
    const chip = screen.getByRole("button", { name: CHIP_NAME });
    const targetRow = rowElement("RELATED query deranking issue");
    const otherRow = rowElement("Unrelated thread");

    expect(targetRow).not.toHaveClass("is-link-target");

    fireEvent.mouseEnter(chip);
    expect(targetRow).toHaveClass("is-link-target");
    expect(otherRow).not.toHaveClass("is-link-target");

    fireEvent.mouseLeave(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("follows keyboard focus the same way as the pointer", async () => {
    renderScene({ text: `See ${TARGET_LINK}` });
    const chip = screen.getByRole("button", { name: CHIP_NAME });
    const targetRow = rowElement("RELATED query deranking issue");

    await focus(chip);
    expect(targetRow).toHaveClass("is-link-target");

    await blur(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("ignores a focus event that is not visible keyboard focus", async () => {
    // Programmatic focus (a context menu returning focus to its invoker, the
    // window re-activating with the button still focused) fires `focus`
    // without `:focus-visible`. Emulate by dispatching without moving
    // `document.activeElement`.
    renderScene({ text: `See ${TARGET_LINK}` });
    const chip = screen.getByRole("button", { name: CHIP_NAME });

    await act(async () => {
      fireEvent.focus(chip);
      await Promise.resolve();
    });

    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
  });

  it("releases the highlight when the chip is activated", () => {
    renderScene({ text: `See ${TARGET_LINK}` });
    const chip = screen.getByRole("button", { name: CHIP_NAME });
    const targetRow = rowElement("RELATED query deranking issue");

    fireEvent.mouseEnter(chip);
    expect(targetRow).toHaveClass("is-link-target");

    fireEvent.click(chip);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("releases the highlight when a hovered chip unmounts without a mouseleave", () => {
    const view = renderScene({ text: `See ${TARGET_LINK}` });
    fireEvent.mouseEnter(screen.getByRole("button", { name: CHIP_NAME }));
    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");

    // Same provider, chip gone: the message re-rendered under the pointer.
    view.rerenderScene({ text: "no link any more" });

    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
  });

  it("keeps a focused link's highlight when the pointer crosses and leaves another link", async () => {
    renderScene({ text: `See ${TARGET_LINK} and ${OTHER_LINK}` });
    const focusedChip = screen.getByRole("button", { name: CHIP_NAME });
    const passingChip = screen.getByRole("button", { name: OTHER_CHIP_NAME });
    const targetRow = rowElement("RELATED query deranking issue");
    const otherRow = rowElement("Unrelated thread");

    await focus(focusedChip);
    expect(targetRow).toHaveClass("is-link-target");

    // The most recent link wins while the pointer rests on it…
    fireEvent.mouseEnter(passingChip);
    expect(otherRow).toHaveClass("is-link-target");
    expect(targetRow).not.toHaveClass("is-link-target");

    // …and leaving it hands the highlight back to the link that still holds
    // focus, rather than wiping the slot.
    fireEvent.mouseLeave(passingChip);
    expect(otherRow).not.toHaveClass("is-link-target");
    expect(targetRow).toHaveClass("is-link-target");
  });

  it("does not let an unmounting link clear a highlight another link holds", async () => {
    const view = renderScene({
      headerThread: otherThread,
      text: `See ${TARGET_LINK}`,
    });
    const chip = screen.getByRole("button", { name: CHIP_NAME });
    const titleLink = screen.getByRole("button", { name: TITLE_LINK_NAME });

    fireEvent.mouseEnter(chip);
    await focus(titleLink);
    expect(rowElement("Unrelated thread")).toHaveClass("is-link-target");

    // The hovered chip unmounts (its message re-renders) while the title
    // still has focus: the title's highlight must survive.
    view.rerenderScene({ headerThread: otherThread, text: "no link" });

    expect(rowElement("Unrelated thread")).toHaveClass("is-link-target");
  });

  it("keeps the highlight while the pointer moves onto a remote link's pop-out", async () => {
    renderScene({
      text: `See [remote](pwragent://thread/${TARGET_THREAD_ID}?backend=codex&instanceId=${REMOTE_INSTANCE_ID})`,
      threads: [remoteThread, otherThread],
    });
    const chip = screen.getByRole("button", { name: CHIP_NAME });
    const popout = screen.getByRole("button", { name: "Open remote viewer for Peer" });
    const targetRow = rowElement("RELATED query deranking issue");

    // Enter the group through the chip; leaving the chip for its sibling
    // pop-out stays inside the group, so no leave fires on the group.
    fireEvent.mouseEnter(chip.parentElement!);
    fireEvent.mouseEnter(chip);
    expect(targetRow).toHaveClass("is-link-target");
    fireEvent.mouseLeave(chip);
    fireEvent.mouseEnter(popout);
    expect(targetRow).toHaveClass("is-link-target");

    // Tab from chip to pop-out likewise stays lit; blurring out of the group
    // releases it.
    await focus(chip);
    await focus(popout);
    expect(targetRow).toHaveClass("is-link-target");
    await blur(popout);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("lights up the selected thread's card from the title-bar thread link", async () => {
    renderScene({ headerThread: targetThread });
    const titleLink = screen.getByRole("button", { name: TITLE_LINK_NAME });
    const targetRow = rowElement("RELATED query deranking issue");
    const otherRow = rowElement("Unrelated thread");

    fireEvent.mouseEnter(titleLink);
    expect(targetRow).toHaveClass("is-link-target");
    expect(otherRow).not.toHaveClass("is-link-target");

    fireEvent.mouseLeave(titleLink);
    expect(targetRow).not.toHaveClass("is-link-target");

    await focus(titleLink);
    expect(targetRow).toHaveClass("is-link-target");
    await blur(titleLink);
    expect(targetRow).not.toHaveClass("is-link-target");
  });

  it("follows a thread switch under a resting pointer on the title-bar link", () => {
    const view = renderScene({ headerThread: targetThread });
    fireEvent.mouseEnter(screen.getByRole("button", { name: TITLE_LINK_NAME }));
    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");

    // ⌘K / sidebar click while the pointer rests on the title: the header
    // stays mounted with a new thread, and no mouse event fires. The lit row
    // must be the one the link now points at.
    view.rerenderScene({ headerThread: otherThread });

    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
    expect(rowElement("Unrelated thread")).toHaveClass("is-link-target");

    fireEvent.mouseLeave(screen.getByRole("button", { name: TITLE_LINK_NAME }));
    expect(rowElement("Unrelated thread")).not.toHaveClass("is-link-target");
  });

  it("keeps the title-bar highlight across a thread-membership change", () => {
    // The provider's context value is rebuilt whenever the set of threads
    // changes; the hover store must not be reset by that.
    const view = renderScene({ headerThread: targetThread });
    fireEvent.mouseEnter(screen.getByRole("button", { name: TITLE_LINK_NAME }));
    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");

    view.rerenderScene({
      headerThread: targetThread,
      threads: [
        targetThread,
        otherThread,
        threadSummary({ id: "019f5d79-a595-73f2-84d9-a0976762c305", title: "New arrival" }),
      ],
    });

    expect(rowElement("RELATED query deranking issue")).toHaveClass("is-link-target");
  });

  it("is inert outside a ThreadLinkProvider", () => {
    render(
      <>
        <ThreadHeader thread={targetThread} onRevealSelectedThreadInList={vi.fn()} />
        <div>{rowFor(targetThread)}</div>
      </>,
    );
    const titleLink = screen.getByRole("button", { name: TITLE_LINK_NAME });
    expect(() => fireEvent.mouseEnter(titleLink)).not.toThrow();
    expect(rowElement("RELATED query deranking issue")).not.toHaveClass(
      "is-link-target",
    );
  });
});
