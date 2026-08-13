import "@testing-library/jest-dom/vitest";
import type { AppServerBackendKind, NavigationThreadSummary } from "@pwragent/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { threadCopyTargets } from "../ThreadChip";
import { ThreadMarkdown } from "../ThreadMarkdown";

const CHILD_THREAD_ID = "019f5d79-a595-73f2-84d9-a0976762c303";
const copyText = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../../lib/copy-text", () => ({ copyText }));

afterEach(() => {
  copyText.mockClear();
});

function threadSummary(
  overrides: Partial<NavigationThreadSummary> = {},
): NavigationThreadSummary {
  return {
    id: CHILD_THREAD_ID,
    title: "RELATED query deranking issue",
    titleSource: "generated",
    source: "codex",
    linkedDirectories: [],
    inbox: { unread: false },
    ...overrides,
  } as NavigationThreadSummary;
}

function renderWithLinks(
  text: string,
  options: {
    onOpenRemoteViewer?: (request: {
      backend: AppServerBackendKind;
      instanceId: string;
      messageId?: string;
      threadId: string;
    }) => void;
    onShowThread?: (request: { backend: AppServerBackendKind; threadId: string }) => void;
    threads?: NavigationThreadSummary[];
  } = {},
) {
  const onOpenRemoteViewer = options.onOpenRemoteViewer ?? vi.fn();
  const onShowThread = options.onShowThread ?? vi.fn();
  return render(
    <ThreadLinkProvider
      onOpenRemoteViewer={onOpenRemoteViewer}
      onShowThread={onShowThread}
      threads={options.threads ?? [threadSummary()]}
    >
      <ThreadMarkdown text={text} />
    </ThreadLinkProvider>,
  );
}

describe("thread links in transcript markdown", () => {
  it("replaces partial text selection with thread-specific copy actions", () => {
    renderWithLinks(
      `Created [the handoff](pwragent://thread/${CHILD_THREAD_ID}?backend=codex)`,
      {
        threads: [threadSummary({
          gitBranch: "agent/thread-chip-menu",
          linkedDirectories: [
            {
              id: "dir-worktree",
              kind: "worktree",
              label: "PwrAgent",
              path: "/Users/huntharo/pwrdrvr/PwrAgent",
              worktreePath: "/Users/huntharo/.codex/worktrees/thread-menu/PwrAgent",
            },
          ],
        })],
      },
    );
    const chip = screen.getByRole("button", {
      name: "Open thread RELATED query deranking issue",
    });
    const contextMenuEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 120,
      clientY: 80,
    });

    fireEvent(chip, contextMenuEvent);

    expect(contextMenuEvent.defaultPrevented).toBe(true);
    expect(chip).toHaveAttribute("draggable", "false");
    expect(chip).toHaveAttribute("aria-haspopup", "menu");
    expect(screen.getByRole("menuitem", {
      name: "Copy Thread Link",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Thread ID",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Thread Name",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Branch Name",
    })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", {
      name: "Copy Thread Directory",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Thread Link" }));
    expect(copyText).toHaveBeenCalledWith(
      `pwragent://thread/${CHILD_THREAD_ID}?backend=codex`,
    );
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(chip).toHaveFocus();
  });

  it("keeps one copy menu open and restores focus on Escape", () => {
    const secondThreadId = "019f5d79-a595-73f2-84d9-a0976762c304";
    renderWithLinks(
      [
        `[first](pwragent://thread/${CHILD_THREAD_ID}?backend=codex)`,
        `[second](pwragent://thread/${secondThreadId}?backend=codex)`,
      ].join(" "),
      {
        threads: [
          threadSummary({ title: "First thread" }),
          threadSummary({ id: secondThreadId, title: "Second thread" }),
        ],
      },
    );
    const firstChip = screen.getByRole("button", { name: "Open thread First thread" });
    const secondChip = screen.getByRole("button", { name: "Open thread Second thread" });

    fireEvent.contextMenu(firstChip, { clientX: 80, clientY: 60 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);

    secondChip.focus();
    fireEvent.contextMenu(secondChip, { clientX: 160, clientY: 90 });
    expect(screen.getAllByRole("menu")).toHaveLength(1);
    expect(screen.getByRole("menuitem", { name: "Copy Thread Link" })).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(secondChip).toHaveFocus();
  });

  it("builds exact copy values from live thread metadata", () => {
    expect(threadCopyTargets({
      backend: "codex",
      threadId: CHILD_THREAD_ID,
      title: "RELATED query deranking issue",
      gitBranch: "agent/thread-chip-menu",
      linkedDirectories: [
        {
          id: "dir-worktree",
          kind: "worktree",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
          worktreePath: "/Users/huntharo/.codex/worktrees/thread-menu/PwrAgent",
        },
      ],
    }, "RELATED query deranking issue")).toEqual([
      {
        label: "Copy Thread Link",
        copyValue: `pwragent://thread/${CHILD_THREAD_ID}?backend=codex`,
      },
      {
        label: "Copy Thread ID",
        copyValue: CHILD_THREAD_ID,
        separated: true,
      },
      {
        label: "Copy Thread Name",
        copyValue: "RELATED query deranking issue",
      },
      {
        label: "Copy Branch Name",
        copyValue: "agent/thread-chip-menu",
      },
      {
        label: "Copy Thread Directory",
        copyValue: "/Users/huntharo/.codex/worktrees/thread-menu/PwrAgent",
      },
    ]);
  });

  it("offers each distinct thread directory when a thread links several", () => {
    expect(threadCopyTargets({
      backend: "codex",
      threadId: CHILD_THREAD_ID,
      linkedDirectories: [
        {
          id: "dir-local",
          kind: "local",
          label: "PwrAgent",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
        },
        {
          id: "dir-worktree",
          kind: "worktree",
          label: "Docs",
          path: "/Users/huntharo/pwrdrvr/docs.pwragent.ai",
          worktreePath: "/Users/huntharo/.codex/worktrees/docs/docs.pwragent.ai",
        },
        {
          id: "dir-duplicate",
          kind: "local",
          label: "Duplicate",
          path: "/Users/huntharo/pwrdrvr/PwrAgent",
        },
      ],
    }, "RELATED query deranking issue").slice(3)).toEqual([
      {
        label: "Copy Thread Directory — PwrAgent (local)",
        copyValue: "/Users/huntharo/pwrdrvr/PwrAgent",
      },
      {
        label: "Copy Thread Directory — Docs (worktree)",
        copyValue: "/Users/huntharo/.codex/worktrees/docs/docs.pwragent.ai",
      },
    ]);
  });

  it("renders a pwragent thread link as a chip showing the thread's live title", () => {
    renderWithLinks(
      `Created [the handoff](pwragent://thread/${CHILD_THREAD_ID}?backend=codex)`,
    );

    // The chip prefers the thread's current title over whatever the author
    // wrote, so a renamed thread does not keep showing a stale label.
    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toHaveTextContent("#RELATED query deranking issue");
    expect(screen.queryByRole("link", { name: "the handoff" })).not.toBeInTheDocument();
  });

  it("navigates to the thread when the chip is clicked", () => {
    const onShowThread = vi.fn();
    renderWithLinks(`See [handoff](pwragent://thread/${CHILD_THREAD_ID})`, {
      onShowThread,
    });

    fireEvent.click(screen.getByRole("button", { name: /Open thread/ }));

    expect(onShowThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: CHILD_THREAD_ID,
    });
  });

  it("keeps an arbitrary remote thread actionable with its owning instance", () => {
    const onShowThread = vi.fn();
    const onOpenRemoteViewer = vi.fn();
    renderWithLinks(
      `See [Remote handoff](pwragent://thread/${CHILD_THREAD_ID}`
        + "?backend=codex&instanceId=pwr_harold&messageId=assistant-message-7)",
      {
        onOpenRemoteViewer,
        onShowThread,
        threads: [],
      },
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Open thread Remote handoff",
    }));

    expect(onShowThread).toHaveBeenCalledWith({
      backend: "codex",
      instanceId: "pwr_harold",
      messageId: "assistant-message-7",
      threadId: CHILD_THREAD_ID,
    });
    expect(onOpenRemoteViewer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", {
      name: "Open remote viewer for pwr_harold",
    }));

    expect(onOpenRemoteViewer).toHaveBeenCalledWith({
      backend: "codex",
      instanceId: "pwr_harold",
      messageId: "assistant-message-7",
      threadId: CHILD_THREAD_ID,
    });
    expect(onShowThread).toHaveBeenCalledTimes(1);
  });

  it("labels a remote thread's pop-out action with its instance name", () => {
    const onOpenRemoteViewer = vi.fn();
    renderWithLinks(
      `See [Remote handoff](pwragent://thread/${CHILD_THREAD_ID}?backend=codex&instanceId=pwr_harold)`,
      {
        onOpenRemoteViewer,
        threads: [threadSummary({
          federation: {
            ref: {
              backend: "codex",
              target: { scope: "remote", instanceId: "pwr_harold" },
              threadId: CHILD_THREAD_ID,
            },
            instanceLabel: "Studio Mac",
            peerStatus: "connected",
          },
        })],
      },
    );

    const popout = screen.getByRole("button", {
      name: "Open remote viewer for Studio Mac",
    });
    fireEvent.mouseEnter(popout);

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Open this thread in the remote viewer window for Studio Mac",
    );
  });

  it("drops live metadata when a federated thread leaves the snapshot", () => {
    const text =
      `See [Remote handoff](pwragent://thread/${CHILD_THREAD_ID}?backend=codex&instanceId=pwr_harold)`;
    const onShowThread = vi.fn();
    const remoteThread = threadSummary({
      title: "Old remote title",
      gitBranch: "agent/old-remote-branch",
      federation: {
        ref: {
          backend: "codex",
          target: { scope: "remote", instanceId: "pwr_harold" },
          threadId: CHILD_THREAD_ID,
        },
        instanceLabel: "Harold",
        peerStatus: "connected",
      },
    });
    const { rerender } = render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[remoteThread]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread Old remote title" }),
    ).toBeInTheDocument();

    rerender(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread Remote handoff" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open thread Old remote title" }))
      .not.toBeInTheDocument();
  });

  it("linkifies a bare thread id written as inline code", () => {
    // The shape every pre-protocol handoff message used.
    renderWithLinks(`Created the PwrAgent handoff thread: \`${CHILD_THREAD_ID}\``);

    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
  });

  it("leaves inline code alone when it is not a known thread id", () => {
    renderWithLinks("Run `pnpm lint:eslint` and check `019f0000-not-a-thread`");

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.getByText("pnpm lint:eslint")).toBeInTheDocument();
  });

  it("does not linkify a thread id inside a fenced code block", () => {
    renderWithLinks(["```", CHILD_THREAD_ID, "```"].join("\n"));

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
  });

  it("degrades an unresolvable thread link to plain text, never a dead anchor", () => {
    // A thread from another profile, or one since deleted. It must not become
    // an <a> — `pwragent:` is absent from the external-open allowlist, so the
    // click would silently do nothing.
    const { container } = renderWithLinks(
      "See [other profile's thread](pwragent://thread/unknown-thread-id)",
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toContain("See other profile's thread");
  });

  it("renders plain text on surfaces that have no thread navigation", () => {
    // Activity / Changelog / markdown-file windows mount ThreadMarkdown with
    // no ThreadLinkProvider above it.
    const { container } = render(
      <ThreadMarkdown text={`See [handoff](pwragent://thread/${CHILD_THREAD_ID})`} />,
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(container.textContent).toContain("See handoff");
  });

  it("prefers the backend named in the link when two backends share a thread id", () => {
    const onShowThread = vi.fn();
    renderWithLinks(`[t](pwragent://thread/${CHILD_THREAD_ID}?backend=acp%3Aclaude-code)`, {
      onShowThread,
      threads: [
        threadSummary({ source: "codex", title: "Codex thread" }),
        threadSummary({ source: "acp:claude-code", title: "ACP thread" }),
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Open thread ACP thread" }));

    expect(onShowThread).toHaveBeenCalledWith({
      backend: "acp:claude-code",
      threadId: CHILD_THREAD_ID,
    });
  });

  it("upgrades a link to a chip once its thread appears in the snapshot", () => {
    // The provider keys its context on thread *membership*, not on the churny
    // array reference, so this proves a newly-hydrated thread (the handoff
    // case) still flips a plain-text link into a chip.
    const text = `See [handoff](pwragent://thread/${CHILD_THREAD_ID})`;
    const onShowThread = vi.fn();
    const { rerender } = render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(screen.queryByRole("button", { name: /Open thread/ })).not.toBeInTheDocument();

    rerender(
      <ThreadLinkProvider onShowThread={onShowThread} threads={[threadSummary()]}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread RELATED query deranking issue" }),
    ).toBeInTheDocument();
  });

  it("updates only the referenced chip metadata when a thread is renamed", () => {
    const text = `See [Untitled thread](pwragent://thread/${CHILD_THREAD_ID})`;
    const onShowThread = vi.fn();
    const { rerender } = render(
      <ThreadLinkProvider
        onShowThread={onShowThread}
        threads={[threadSummary({ title: "Untitled thread", titleSource: "fallback" })]}
      >
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    const markdownNode = screen.getByText("See").parentElement;
    expect(
      screen.getByRole("button", { name: "Open thread Untitled thread" }),
    ).toBeInTheDocument();

    rerender(
      <ThreadLinkProvider
        onShowThread={onShowThread}
        threads={[threadSummary({ title: "EMR JDK 17 guidance" })]}
      >
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread EMR JDK 17 guidance" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open thread Untitled thread" }))
      .not.toBeInTheDocument();
    expect(screen.getByText("See").parentElement).toBe(markdownNode);
  });

  it("updates when navigation reuses its thread collection across a rename", () => {
    const text = `See [Untitled thread](pwragent://thread/${CHILD_THREAD_ID})`;
    const onShowThread = vi.fn();
    const threads = [
      threadSummary({ title: "Untitled thread", titleSource: "fallback" }),
    ];
    const { rerender } = render(
      <ThreadLinkProvider onShowThread={onShowThread} threads={threads}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread Untitled thread" }),
    ).toBeInTheDocument();
    const markdownNode = screen.getByText("See").parentElement;

    // A snapshot producer may retain its collection while replacing a changed
    // summary. Consumers reading the collection directly see the new title;
    // the chip metadata store must also resync.
    threads[0] = threadSummary({ title: "Named child thread" });
    rerender(
      <ThreadLinkProvider onShowThread={onShowThread} threads={threads}>
        <ThreadMarkdown text={text} />
      </ThreadLinkProvider>,
    );

    expect(
      screen.getByRole("button", { name: "Open thread Named child thread" }),
    ).toBeInTheDocument();
    expect(screen.getByText("See").parentElement).toBe(markdownNode);
  });
});
