import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, ThreadLock } from "@pwragent/shared";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import {
  ThreadView as ThreadViewWithTerminals,
  type ThreadViewProps,
} from "../ThreadView";

function ThreadView(props: Omit<ThreadViewProps, "terminals">): ReactElement {
  const terminals = useIntegratedTerminals(props.desktopApi);
  return <ThreadViewWithTerminals {...props} terminals={terminals} />;
}

afterEach(() => {
  cleanup();
});

const baseProps: Omit<ThreadViewProps, "terminals"> = {
  addOptimisticUserMessage: () => "optimistic-1",
  backends: [],
  clearPendingRequest: () => undefined,
  composerDisabled: true,
  loading: false,
  loadingMore: false,
  messageCount: 0,
  skills: [],
  transcriptEntries: [],
  onLoadOlder: async () => undefined,
  removeOptimisticMessage: () => undefined,
};

const lock: ThreadLock = {
  note: "Worktree handed to another agent.\nDon't reply here.",
  lockedAt: Date.UTC(2026, 9, 5, 18, 31),
  source: "agent_tool",
};

function lockedThread(overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id: "parked", source: "codex", title: "Add /fork parameters", titleSource: "explicit",
    linkedDirectories: [], inbox: { inInbox: false }, lock, ...overrides,
  };
}

describe("ThreadView lock", () => {
  it("dims the thread and shows the note, its source and Unlock over it", async () => {
    const onSetThreadLock = vi.fn(async () => undefined);
    const { container } = render(
      <ThreadView {...baseProps} selectedThread={lockedThread()} onSetThreadLock={onSetThreadLock} />,
    );

    expect(container.querySelector(".thread-view__primary")).toHaveClass("thread-view__primary--locked");
    const card = screen.getByRole("region", { name: "Thread locked" });
    expect(card).toHaveTextContent("Worktree handed to another agent.");
    expect(card).toHaveTextContent("Agent tool ·");

    fireEvent.click(within(card).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(onSetThreadLock).toHaveBeenCalledWith(false));
  });

  it("edits the note in a dialog seeded with the current note", async () => {
    const onSetThreadLock = vi.fn(async () => undefined);
    render(<ThreadView {...baseProps} selectedThread={lockedThread()} onSetThreadLock={onSetThreadLock} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Note" }));
    const dialog = screen.getByRole("dialog", { name: "Edit Lock Note" });
    const note = within(dialog).getByLabelText("Note");
    expect(note).toHaveValue(lock.note);
    fireEvent.change(note, { target: { value: "Parked until the repair merges." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save Note" }));

    await waitFor(() => expect(onSetThreadLock).toHaveBeenCalledWith(true, "Parked until the repair merges."));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the card and reports the error when an unlock fails", async () => {
    const onSetThreadLock = vi.fn(async () => {
      throw new Error("The owning instance is disconnected.");
    });
    render(<ThreadView {...baseProps} selectedThread={lockedThread()} onSetThreadLock={onSetThreadLock} />);

    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The owning instance is disconnected.");
    expect(screen.getByRole("region", { name: "Thread locked" })).toBeInTheDocument();
  });

  it("offers Add Note for a lock without one, and shows nothing for an unlocked thread", () => {
    const view = render(
      <ThreadView
        {...baseProps}
        selectedThread={lockedThread({ lock: { lockedAt: 1, source: "operator" } })}
        onSetThreadLock={async () => undefined}
      />,
    );
    expect(screen.getByText("No note.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add Note" })).toBeInTheDocument();

    view.rerender(
      <ThreadView
        {...baseProps}
        composerDisabled={false}
        selectedThread={lockedThread({ lock: undefined })}
        onSetThreadLock={async () => undefined}
      />,
    );
    expect(screen.queryByRole("region", { name: "Thread locked" })).toBeNull();
    expect(view.container.querySelector(".thread-view__primary--locked")).toBeNull();
  });
});
