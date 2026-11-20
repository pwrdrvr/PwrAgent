import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { useIntegratedTerminals } from "../../../lib/useIntegratedTerminals";
import { appStyleRules } from "../../../styles/__tests__/css-style-rules";
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

/**
 * Whether a top-level app.css rule that puts its element in the composer's
 * column (centred, capped at `--chat-column-max`) matches `element` where
 * ThreadView actually renders it. The stylesheet oracle in
 * `styles/__tests__/recovery-slot-column.test.ts` checks that column's edges;
 * this checks the selector reaches the rendered card. A selector naming the
 * wrong parent once left the card edge to edge with that oracle green.
 */
function inComposerColumn(element: Element | null): boolean {
  if (!element) return false;
  return appStyleRules.some((rule) => rule.atRules.length === 0
    && /align-self:\s*center/.test(rule.body)
    && /max-width:\s*var\(--chat-column-max\)/.test(rule.body)
    && rule.selectors.some((selector) => element.matches(selector)));
}

/** Whether a top-level rule zeroes `element`'s top padding where it renders. */
function topPaddingZeroed(element: Element | null): boolean {
  if (!element) return false;
  return appStyleRules.some((rule) => rule.atRules.length === 0
    && /padding-top:\s*0\b/.test(rule.body)
    && rule.selectors.some((selector) => element.matches(selector)));
}

describe("ThreadView with a missing worktree", () => {
  it("replaces the composer with the recovery card", () => {
    const { container } = render(<ThreadView {...baseProps} selectedThread={thread()} />);

    expect(screen.getByRole("region", { name: /worktree is gone/ })).toBeInTheDocument();
    expect(container.querySelector(".composer")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Open integrated terminal" });
    expect(toggle.closest(".composer__footer .composer__application-actions")).not.toBeNull();
    expect(toggle).toBeEnabled();
    // The card and the footer that stands in for the composer share its column.
    expect(inComposerColumn(container.querySelector(".missing-worktree-card"))).toBe(true);
    expect(inComposerColumn(toggle.closest(".composer__footer"))).toBe(true);
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

describe("ThreadView with a hibernated checkout", () => {
  const workspaceHibernated = {
    worktreePath: WORKTREE, repositoryPath: "/home/dev/src/atlas", hibernatedAt: 1,
    branch: "fix/retry-backoff", changedFileCount: 2, changedBytes: 2048,
  };

  it("shows the hibernated card above a composer that stays", () => {
    const { container } = render(
      <ThreadView {...baseProps} selectedThread={thread({ workspaceMissing: undefined, workspaceHibernated })} />,
    );
    expect(screen.getByRole("region", { name: /Checkout hibernated/ })).toBeInTheDocument();
    expect(container.querySelector(".composer")).not.toBeNull();
    // Same column as the composer, and the card's margin alone is the gap.
    const card = container.querySelector(".missing-worktree-card");
    expect(inComposerColumn(card)).toBe(true);
    expect(card?.nextElementSibling).toBe(container.querySelector(".composer"));
    expect(topPaddingZeroed(container.querySelector(".composer"))).toBe(true);
  });

  it("routes Restore now and Keep it awake to the owner", async () => {
    const onSetThreadCheckoutHibernation = vi.fn(async () => ({
      backend: "codex" as const, threadId: "t1", keepAwake: true, hibernated: false,
    }));
    render(
      <ThreadView
        {...baseProps}
        selectedThread={thread({ workspaceMissing: undefined, workspaceHibernated })}
        onSetThreadCheckoutHibernation={onSetThreadCheckoutHibernation}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it awake" }));
    await waitFor(() => expect(onSetThreadCheckoutHibernation).toHaveBeenCalledWith({ keepAwake: true }));
    fireEvent.click(screen.getByRole("button", { name: "Restore now" }));
    await waitFor(() => expect(onSetThreadCheckoutHibernation).toHaveBeenLastCalledWith({ restore: true }));
  });

  it("gives way to the missing-worktree card once a restore is refused", () => {
    render(<ThreadView {...baseProps} selectedThread={thread({ workspaceHibernated })} />);
    expect(screen.getByRole("region", { name: /worktree is gone/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Checkout hibernated/ })).toBeNull();
  });
});

describe("ThreadView with an archived thread", () => {
  const snapshot = {
    id: "s1", backend: "codex" as const, threadId: "t1", worktreePath: WORKTREE, repositoryPath: "/home/dev/src/atlas",
    snapshotRef: "refs/pwragent/snapshots/s1", snapshotCommit: "abc123", sourceBranch: "fix/retry-backoff",
    createdAt: 1, archivedAt: 2, state: "archived" as const, ignoredFilesExcluded: true,
  };
  const archived = (overrides: Partial<NavigationThreadSummary> = {}) =>
    thread({ archivedAt: 2, worktreeSnapshots: [snapshot], ...overrides });

  it("replaces the composer with the archived card, not the missing-worktree card", () => {
    const { container } = render(
      <ThreadView {...baseProps} selectedThread={archived()} selectedThreadArchived onRestoreArchivedThread={async () => undefined} />,
    );

    const card = screen.getByRole("region", { name: /Thread archived/ });
    expect(card).toHaveTextContent(WORKTREE);
    expect(card).toHaveTextContent("fix/retry-backoff · recovery snapshot saved");
    expect(card).toHaveTextContent("Restore it to reply.");
    expect(screen.queryByRole("region", { name: /worktree is gone/ })).toBeNull();
    expect(container.querySelector(".composer")).toBeNull();
    expect(screen.getByRole("button", { name: "Open integrated terminal" })).toBeEnabled();
    expect(inComposerColumn(card)).toBe(true);
  });

  it("restores only on Restore thread, and shows a refused restore in the card", async () => {
    const onRestoreArchivedThread = vi.fn(async () => {
      throw new Error("Worktree restoration failed; the thread remains archived.");
    });
    render(<ThreadView {...baseProps} selectedThread={archived()} selectedThreadArchived onRestoreArchivedThread={onRestoreArchivedThread} />);
    expect(onRestoreArchivedThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Restore thread" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("the thread remains archived"));
    expect(onRestoreArchivedThread).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("names the owner and offers no restore when this window cannot restore it", () => {
    render(
      <ThreadView
        {...baseProps}
        activeFederationOwnerLabel="Build Mac"
        selectedThread={archived({ workspaceMissing: undefined, worktreeSnapshots: [] })}
        selectedThreadArchived
      />,
    );

    expect(screen.getByRole("region", { name: /Thread archived/ })).toHaveTextContent("Restore it on Build Mac to reply.");
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
  });

  // Oracle over every slot input. An archived thread never shows a composer
  // that looks ready (unless a turn is live, so Stop stays reachable), and
  // never the missing-worktree or hibernated card, whose actions would act
  // on a thread the operator archived.
  it.each(
    [false, true].flatMap((isArchived) => [false, true].flatMap((missing) => [false, true].flatMap((hibernated) =>
      [false, true].map((turn) => ({ isArchived, missing, hibernated, turn }))))),
  )("slot for %o", ({ isArchived, missing, hibernated, turn }) => {
    const selected = thread({
      workspaceMissing: missing ? thread().workspaceMissing : undefined,
      workspaceHibernated: hibernated
        ? { worktreePath: WORKTREE, repositoryPath: "/home/dev/src/atlas", hibernatedAt: 1 }
        : undefined,
      ...(isArchived ? { archivedAt: 2, worktreeSnapshots: [snapshot] } : {}),
    });
    const { container } = render(
      <ThreadView {...baseProps} activeTurnId={turn ? "turn-1" : undefined} selectedThread={selected} selectedThreadArchived={isArchived} />,
    );

    const archivedCard = screen.queryByRole("region", { name: /Thread archived/ });
    const missingCard = screen.queryByRole("region", { name: /worktree is gone/ });
    const hibernatedCard = screen.queryByRole("region", { name: /Checkout hibernated/ });
    expect(Boolean(archivedCard)).toBe(isArchived);
    expect(Boolean(missingCard)).toBe(!isArchived && missing);
    expect(Boolean(hibernatedCard)).toBe(!isArchived && !missing && hibernated);
    expect(container.querySelector(".composer") !== null).toBe(turn || (!isArchived && !missing));
  });
});
