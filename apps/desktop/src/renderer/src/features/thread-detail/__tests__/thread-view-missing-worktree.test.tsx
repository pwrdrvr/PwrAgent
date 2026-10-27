import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared";
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
  composerDisabled: false,
  loading: false,
  loadingMore: false,
  messageCount: 0,
  skills: [],
  transcriptEntries: [],
  onLoadOlder: async () => undefined,
  removeOptimisticMessage: () => undefined,
};

const WORKTREE = "/home/dev/.pwragent/worktrees/mf3k2q/atlas";

function thread(overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id: "t1", source: "codex", title: "Retry backoff for webhook deliveries", titleSource: "explicit",
    linkedDirectories: [{ id: "d1", label: "atlas", kind: "worktree", path: "/home/dev/src/atlas", worktreePath: WORKTREE }],
    inbox: { inInbox: false },
    workspaceMissing: {
      worktreePath: WORKTREE, repositoryPath: "/home/dev/src/atlas", repositoryAvailable: true,
      branch: "fix/retry-backoff", mainCheckoutBranch: "main",
    },
    ...overrides,
  };
}

describe("ThreadView with a missing worktree", () => {
  it("replaces the composer with the recovery card", () => {
    const { container } = render(<ThreadView {...baseProps} selectedThread={thread()} />);

    expect(screen.getByRole("region", { name: /worktree is gone/ })).toBeInTheDocument();
    expect(container.querySelector(".composer")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Open integrated terminal" });
    expect(toggle.closest(".composer__footer .composer__application-actions")).not.toBeNull();
    expect(toggle).toBeEnabled();
  });

  it("keeps the composer during a live turn so the turn can still be stopped", () => {
    const { container } = render(<ThreadView {...baseProps} activeTurnId="turn-1" selectedThread={thread()} />);

    expect(screen.getByRole("region", { name: /worktree is gone/ })).toHaveTextContent("Available when the current turn ends.");
    expect(container.querySelector(".composer")).not.toBeNull();
  });

  it("shows the composer for a thread whose worktree exists", () => {
    const { container } = render(<ThreadView {...baseProps} selectedThread={thread({ workspaceMissing: undefined })} />);

    expect(screen.queryByRole("region", { name: /worktree is gone/ })).toBeNull();
    expect(container.querySelector(".composer")).not.toBeNull();
  });

  it("brings the composer back with a result row once the thread moves", async () => {
    const onMoveThreadToMainCheckout = vi.fn(async () => ({
      backend: "codex" as const, threadId: "t1", repositoryPath: "/home/dev/src/atlas", branch: "main", warnings: [], completedAt: 1,
      linkedDirectory: { id: "pwragent-handoff:codex:t1", kind: "local" as const, label: "atlas", path: "/home/dev/src/atlas" },
    }));
    const { container } = render(
      <ThreadView {...baseProps} selectedThread={thread()} onMoveThreadToMainCheckout={onMoveThreadToMainCheckout} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Moved to the main checkout."));
    expect(onMoveThreadToMainCheckout).toHaveBeenCalledWith(WORKTREE);
    expect(container.querySelector(".composer")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    // Until the owner's next detail read lands, the card comes back.
    expect(screen.getByRole("region", { name: /worktree is gone/ })).toBeInTheDocument();
  });

  it("archives through the thread's archive action", async () => {
    const onArchiveThread = vi.fn(async () => undefined);
    const selected = thread();
    render(<ThreadView {...baseProps} selectedThread={selected} onArchiveThread={onArchiveThread} />);

    fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => expect(onArchiveThread).toHaveBeenCalledWith(selected));
  });
});
