import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";

// Regression coverage for the unified chip-flow refactor (#188 / plan
// 2026-05-05-001). The historical bug pattern was:
//
//   1. Per-chip-type containers stacked binding chips on their own line
//      and broke ordering/wrapping with the reaction picker.
//   2. Nested `<button>` elements (binding chip inside the row's
//      `<button>`) ate inner clicks — making the binding chip
//      effectively unclickable, or making the click select the thread
//      instead of opening the binding menu.
//
// These tests freeze the contract that motivated the refactor:
//   - Content chips are siblings inside a single `.thread-row__chips`
//     container — no per-type wrappers. The hover-only add-reaction
//     trigger stays outside that flow so it cannot reserve hidden wrap
//     space.
//   - Interactive chips are `<span role="button">` (NOT `<button>`),
//     and their click events do not propagate into the row's
//     onSelectThread handler.
//   - The add-reaction trigger is the SmileyIcon SVG (not a "+" or
//     the OS-rendered 🙂 emoji which read as bright yellow on dark).

const baseThread: NavigationThreadSummary = {
  id: "thread-chips",
  title: "Chip flow thread",
  titleSource: "explicit",
  summary: "Test row for chip-flow regression",
  source: "codex",
  gitBranch: "feat/chips",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
};

const telegramBinding: MessagingThreadBindingSummary = {
  bindingId: "binding-tg-1",
  platform: "telegram",
  conversationKind: "topic",
  conversationTitle: "Wood chuck joke",
  parentTitle: "PwrDrvr",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadRow chip flow", () => {
  function renderRow(
    overrides: Partial<React.ComponentProps<typeof ThreadRow>> = {},
  ) {
    const onSelectThread = vi.fn();
    const onUnbindMessagingBinding = vi.fn(async () => undefined);
    const onSetReaction = vi.fn(async () => undefined);
    const onOpenContextMenu = vi.fn();
    const props: React.ComponentProps<typeof ThreadRow> = {
      thread: {
        ...baseThread,
        messagingBindings: [telegramBinding],
        reactions: ["🙂"],
      },
      onSelectThread,
      onOpenContextMenu,
      onUnbindMessagingBinding,
      onSetReaction,
      ...overrides,
    };
    const utils = render(<ThreadRow {...props} />);
    return { ...utils, onSelectThread, onUnbindMessagingBinding, onSetReaction };
  }

  it("renders content chips as siblings inside a single .thread-row__chips container", () => {
    const { container } = renderRow();
    const chipFlow = container.querySelectorAll(".thread-row__chips");
    expect(chipFlow.length).toBe(1);
    // Content chip types should live inside that single container,
    // not in any per-type wrapper.
    const flow = chipFlow[0]!;
    expect(flow.querySelector(".thread-row__chip--binding")).not.toBeNull();
    expect(flow.querySelector(".thread-row__chip--reaction")).not.toBeNull();
    expect(flow.querySelector(".thread-row__chip--add-reaction")).toBeNull();
  });

  it("positions the add-reaction trigger outside the wrapping chip flow", () => {
    const { container } = renderRow();
    const actions = container.querySelector(".thread-row__actions");
    const flow = container.querySelector(".thread-row__chips");
    const addReaction = container.querySelector(".thread-row__chip--add-reaction");
    expect(actions).not.toBeNull();
    expect(flow).not.toBeNull();
    expect(addReaction).not.toBeNull();
    expect(addReaction?.parentElement).toBe(actions);
    expect(flow?.contains(addReaction)).toBe(false);
  });

  it("keeps the add-reaction trigger left of the overflow action", () => {
    const { container } = renderRow();
    const actions = container.querySelector(".thread-row__actions");
    expect(actions).not.toBeNull();
    const actionChildren = Array.from(actions!.children) as HTMLElement[];
    expect(actionChildren[0]).toHaveClass("thread-row__chip--add-reaction");
    expect(actionChildren[1]).toHaveClass("thread-row__overflow-button");
  });

  it("uses span[role=button] for the binding chip (not nested <button>)", () => {
    const { container } = renderRow();
    const bindingChip = container.querySelector(".thread-row__chip--binding");
    expect(bindingChip).not.toBeNull();
    // The historical bug was a nested <button>. Lock the role+tag shape.
    expect(bindingChip?.tagName).toBe("SPAN");
    expect(bindingChip?.getAttribute("role")).toBe("button");
  });

  it("renders Slack binding chips with the Slack icon", () => {
    const slackBinding: MessagingThreadBindingSummary = {
      ...telegramBinding,
      bindingId: "binding-slack-1",
      platform: "slack",
    };
    const { container } = renderRow({
      thread: {
        ...baseThread,
        messagingBindings: [slackBinding],
        reactions: [],
      },
    });
    const bindingChip = container.querySelector(".thread-row__chip--binding");
    expect(bindingChip?.querySelector("img")).not.toBeNull();
    expect(bindingChip?.textContent).not.toContain("sl");
  });

  it("labels a Slack group DM (mpim) as a Group DM, not a channel", () => {
    const groupDmBinding: MessagingThreadBindingSummary = {
      ...telegramBinding,
      bindingId: "binding-slack-gdm",
      platform: "slack",
      conversationKind: "channel",
      conversationTitle: "mpdm-hhunt--pankaj--pwragent_hhunt-1",
    };
    const { container } = renderRow({
      thread: {
        ...baseThread,
        messagingBindings: [groupDmBinding],
        reactions: [],
      },
    });
    const bindingChip = container.querySelector(".thread-row__chip--binding");
    expect(bindingChip?.textContent).toContain("Group DM");
    expect(bindingChip?.textContent).not.toContain("Channel");
    const ariaLabel = bindingChip?.getAttribute("aria-label") ?? "";
    expect(ariaLabel).toContain("Type: Group DM");
    expect(ariaLabel).toContain("hhunt, pankaj, pwragent_hhunt");
  });

  it("renders Feishu / Lark binding chips with the Lark icon", () => {
    const feishuBinding: MessagingThreadBindingSummary = {
      ...telegramBinding,
      bindingId: "binding-feishu-1",
      platform: "feishu",
      conversationKind: "dm",
      conversationTitle: "Lark DM",
      parentTitle: undefined,
    };
    const { container } = renderRow({
      thread: {
        ...baseThread,
        messagingBindings: [feishuBinding],
        reactions: [],
      },
    });
    const bindingChip = container.querySelector(".thread-row__chip--binding");
    expect(bindingChip?.querySelector("img")).not.toBeNull();
    expect(bindingChip?.textContent).not.toContain("fe");
  });

  it("does not invoke onSelectThread when a binding chip is clicked", () => {
    const { container, onSelectThread, onUnbindMessagingBinding } = renderRow();
    const bindingChip = container.querySelector(
      ".thread-row__chip--binding",
    ) as HTMLElement;
    fireEvent.click(bindingChip);
    // Click on the chip opens the unbind menu, but must not bubble up
    // and select the thread (the regression that motivated the
    // refactor).
    expect(onSelectThread).not.toHaveBeenCalled();
    // The handler is wired to the menu, not the unbind RPC — opening
    // the menu does not call onUnbindMessagingBinding directly.
    expect(onUnbindMessagingBinding).not.toHaveBeenCalled();
  });

  it("does not invoke onSelectThread when the add-reaction smiley is clicked", () => {
    const { container, onSelectThread } = renderRow();
    const addReaction = container.querySelector(
      ".thread-row__chip--add-reaction",
    ) as HTMLElement;
    expect(addReaction).not.toBeNull();
    fireEvent.click(addReaction);
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("includes the expanded first-row reaction presets", () => {
    const { container } = renderRow();
    const addReaction = container.querySelector(
      ".thread-row__chip--add-reaction",
    ) as HTMLElement;

    fireEvent.click(addReaction);

    const statusGroup = screen.getByRole("group", { name: "Status" });
    const options = within(statusGroup).getAllByRole("menuitemradio");
    expect(options.map((option) => option.textContent)).toEqual([
      "👀",
      "✋",
      "✅",
      "❌",
      "😢",
      "🚀",
      "🎉",
      "🙏",
      "🤔",
      "😱",
      "💩",
    ]);
  });

  it("does not invoke onSelectThread when an existing reaction chip is clicked", () => {
    const { container, onSelectThread, onSetReaction } = renderRow();
    const reaction = container.querySelector(
      ".thread-row__chip--reaction",
    ) as HTMLElement;
    fireEvent.click(reaction);
    expect(onSelectThread).not.toHaveBeenCalled();
    // But onSetReaction IS invoked — the reaction toggle still works.
    expect(onSetReaction).toHaveBeenCalledOnce();
  });

  it("renders SmileyIcon SVG as the add-reaction trigger (regression: not '+' or OS emoji)", () => {
    const { container } = renderRow();
    const addReaction = container.querySelector(
      ".thread-row__chip--add-reaction",
    );
    // Stroke-based SVG icon, not the OS-rendered 🙂 emoji (which
    // ignored the chip's foreground color and looked yellow), and
    // not the literal "+" plus sign that we used pre-refactor.
    expect(addReaction?.querySelector("svg")).not.toBeNull();
    expect(addReaction?.textContent ?? "").not.toContain("🙂");
    expect(addReaction?.textContent ?? "").not.toContain("+");
  });

  it("prefetches terminal-only PR chip sets after hover dwell", () => {
    vi.useFakeTimers();
    try {
      const onPrefetchPullRequests = vi.fn();
      const thread: NavigationThreadSummary = {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 542,
            org: "pwrdrvr",
            repo: "PwrAgent",
            state: "unknown",
            lifecycleState: "merged",
            checkState: "unknown",
            reviewState: "ready_for_review",
            mergeState: "unknown",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/542",
          },
        ],
      };
      const { container } = renderRow({
        thread,
        onPrefetchPullRequests,
      });

      fireEvent.mouseEnter(container.querySelector(".thread-row__chips")!);
      vi.advanceTimersByTime(749);
      expect(onPrefetchPullRequests).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(onPrefetchPullRequests).toHaveBeenCalledWith(thread);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a full card without action controls for the drag preview", () => {
    vi.useFakeTimers();
    try {
      const { container } = renderRow({
        compact: true,
        draggable: true,
      });
      const shell = container.querySelector(".thread-row-shell") as HTMLElement;
      const dataTransfer = {
        setDragImage: vi.fn(),
      };

      fireEvent.dragStart(shell, {
        clientX: 12,
        clientY: 18,
        dataTransfer,
      });

      const dragImage = document.body.querySelector(".thread-row--drag-image");
      expect(dragImage).not.toBeNull();
      expect(dragImage).not.toHaveClass("thread-row--compact");
      expect(dragImage?.querySelector(".thread-row__actions")).toBeNull();
      expect(
        dragImage?.querySelector(".thread-row__chip--add-reaction"),
      ).toBeNull();
      expect(dragImage?.querySelector(".thread-row__overflow-button")).toBeNull();
      expect(dataTransfer.setDragImage).toHaveBeenCalledWith(
        dragImage,
        expect.any(Number),
        expect.any(Number),
      );
    } finally {
      vi.runOnlyPendingTimers();
      vi.useRealTimers();
    }
  });

  it("marks the active drop edge on the row shell", () => {
    const { container } = renderRow({ dropIndicator: "after" });
    expect(container.querySelector(".thread-row-shell")).toHaveClass(
      "is-drop-target-after",
    );
  });

  it("still selects the thread when the row body (outside chips) is clicked", () => {
    const { onSelectThread } = renderRow();
    // The row's accessible name is the thread title; click that to
    // hit the row button, not a chip.
    const rowButton = screen.getByRole("button", { name: /Chip flow thread/i });
    fireEvent.click(rowButton);
    expect(onSelectThread).toHaveBeenCalledOnce();
  });

  it("renders an observed branch chip without treating it as expected branch drift", () => {
    renderRow({
      thread: {
        ...baseThread,
        gitBranch: undefined,
        observedGitBranch: "fix/current",
      },
    });

    expect(screen.getByText("fix/current")).toBeInTheDocument();
    expect(screen.queryByText("now fix/current")).not.toBeInTheDocument();
  });

  it("orders chips: meta → bindings → PR → reactions", () => {
    const threadWithEverything: NavigationThreadSummary = {
      ...baseThread,
      messagingBindings: [telegramBinding],
      reactions: ["🙂"],
      prs: [
        {
          provider: "github.com",
          number: 123,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "passing",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
        },
      ],
    };
    const { container } = renderRow({ thread: threadWithEverything });
    const flow = container.querySelector(".thread-row__chips") as HTMLElement;
    const chipNodes = Array.from(flow.children) as HTMLElement[];
    // Find the index of each known chip class. Order check is by index;
    // we don't assert the count of meta chips since that depends on
    // ThreadMetaChips internals.
    const indexOf = (selector: string): number =>
      chipNodes.findIndex((el) => el.matches(selector) || el.querySelector(selector) !== null);
    const prIdx = indexOf(".thread-row__chip--pr, [data-pr-chip]");
    const bindingIdx = indexOf(".thread-row__chip--binding, .thread-row__chip-wrap");
    const reactionIdx = indexOf(".thread-row__chip--reaction");
    // Each chip type that's present comes after the previous one. Messaging
    // bindings sit before PR chips so fixed-width metadata packs first and
    // the variable-count PR + reaction chips trail at the end.
    if (bindingIdx >= 0 && prIdx >= 0) expect(bindingIdx).toBeLessThan(prIdx);
    if (prIdx >= 0 && reactionIdx >= 0) expect(prIdx).toBeLessThan(reactionIdx);
  });

  it("shows the PR title and status in the shared viewport tooltip", () => {
    renderRow({
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 123,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "Retain thread pull request history",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#123/,
    });
    expect(prChip).not.toHaveAttribute("title");

    fireEvent.mouseEnter(prChip);

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveClass("viewport-tooltip");
    expect(tooltip).toHaveTextContent("Retain thread pull request history");
    expect(tooltip).toHaveTextContent(
      "pwrdrvr/PwrAgent#123 — ready for review · checks passing",
    );
  });

  it("dismisses the PR tooltip on window blur (cmd-tab away leaves no mouseleave)", () => {
    renderRow({
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 123,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "Retain thread pull request history",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#123/,
    });
    fireEvent.mouseEnter(prChip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    // Switching apps never fires mouseleave on the chip, so the tooltip
    // would otherwise linger. Window blur must tear it down.
    fireEvent.blur(window);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("dismisses the PR tooltip before opening the PR in the browser", () => {
    const onOpenPullRequest = vi.fn();
    renderRow({
      onOpenPullRequest,
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 123,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "Retain thread pull request history",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#123/,
    });
    fireEvent.mouseEnter(prChip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.click(prChip);

    expect(onOpenPullRequest).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent/pull/123",
    );
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("removes PR chip focus before opening the browser so refocus cannot restore its tooltip", () => {
    const onOpenPullRequest = vi.fn();
    renderRow({
      onOpenPullRequest,
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 123,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "Retain thread pull request history",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#123/,
    });
    prChip.focus();
    fireEvent.focus(prChip);
    expect(prChip).toHaveFocus();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    fireEvent.click(prChip);

    expect(onOpenPullRequest).toHaveBeenCalledWith(
      "https://github.com/pwrdrvr/PwrAgent/pull/123",
    );
    expect(prChip).not.toHaveFocus();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("dismisses the PR tooltip when the thread list scrolls", () => {
    const { container } = renderRow({
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 123,
            org: "pwrdrvr",
            repo: "PwrAgent",
            title: "Retain thread pull request history",
            state: "passing",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: /Open pwrdrvr\/PwrAgent#123/,
    });
    fireEvent.mouseEnter(prChip);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();

    // The portal is position:fixed, so it detaches from its target on scroll.
    // A capture-phase scroll listener must dismiss it.
    fireEvent.scroll(container);
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("renders merged PRs as terminal purple chips without unknown check status", () => {
    renderRow({
      thread: {
        ...baseThread,
        prs: [
          {
            provider: "github.com",
            number: 542,
            org: "pwrdrvr",
            repo: "PwrAgent",
            lifecycleState: "merged",
            checkState: "unknown",
            state: "unknown",
            url: "https://github.com/pwrdrvr/PwrAgent/pull/542",
          },
        ],
      },
    });

    const prChip = screen.getByRole("button", {
      name: "Open pwrdrvr/PwrAgent#542 (merged) in browser",
    });
    expect(prChip).toHaveClass("pr-chip--merged");
    expect(prChip).not.toHaveClass("pr-chip--unknown");

    fireEvent.mouseEnter(prChip);

    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "pwrdrvr/PwrAgent#542 — merged",
    );
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("status unknown");
  });

  it("renders dirty-tree line counts and unpushed-commit chips from gitWorkingState", () => {
    const { container } = renderRow({
      thread: {
        ...baseThread,
        gitWorkingState: {
          dirtyFiles: 3,
          dirtyAdditions: 112,
          dirtyDeletions: 3,
          untrackedFiles: 1,
          unpushedCommits: 4,
        },
      },
    });

    const dirtyChip = container.querySelector(".thread-row__chip--dirty");
    expect(dirtyChip).not.toBeNull();
    expect(dirtyChip).toHaveTextContent("+112");
    expect(dirtyChip).toHaveTextContent("-3");
    expect(dirtyChip).toHaveAttribute(
      "aria-label",
      "Uncommitted changes: 3 files, +112, -3; 1 untracked file",
    );

    const unpushedChip = container.querySelector(".thread-row__chip--unpushed");
    expect(unpushedChip).not.toBeNull();
    expect(unpushedChip).toHaveTextContent("↑4");
    expect(unpushedChip).toHaveAttribute(
      "aria-label",
      "4 commits not pushed to a remote",
    );
  });

  it("renders an untracked-only dirty chip with +/- stats when available", () => {
    const { container } = renderRow({
      thread: {
        ...baseThread,
        gitWorkingState: {
          dirtyFiles: 3,
          dirtyAdditions: 17,
          dirtyDeletions: 0,
          untrackedFiles: 3,
          unpushedCommits: 0,
        },
      },
    });

    const dirtyChip = container.querySelector(".thread-row__chip--dirty");
    expect(dirtyChip).toHaveTextContent("+17");
    expect(dirtyChip).toHaveTextContent("-0");
    expect(dirtyChip).toHaveAttribute(
      "aria-label",
      "Uncommitted changes: 3 files, +17, -0; 3 untracked files",
    );
    expect(container.querySelector(".thread-row__chip--unpushed")).toBeNull();
  });

  it("renders a legacy untracked-only dirty chip without +/- stats", () => {
    const { container } = renderRow({
      thread: {
        ...baseThread,
        gitWorkingState: {
          dirtyFiles: 0,
          dirtyAdditions: 0,
          dirtyDeletions: 0,
          untrackedFiles: 3,
          unpushedCommits: 0,
        },
      },
    });

    const dirtyChip = container.querySelector(".thread-row__chip--dirty");
    expect(dirtyChip).toHaveTextContent("3 new");
    expect(container.querySelector(".thread-row__chip-stat--added")).toBeNull();
    expect(container.querySelector(".thread-row__chip--unpushed")).toBeNull();
  });

  it("renders no git working-state chips when the tree is clean and pushed", () => {
    const { container } = renderRow({
      thread: {
        ...baseThread,
        gitWorkingState: {
          dirtyFiles: 0,
          dirtyAdditions: 0,
          dirtyDeletions: 0,
          untrackedFiles: 0,
          unpushedCommits: 0,
        },
      },
    });

    expect(container.querySelector(".thread-row__chip--dirty")).toBeNull();
    expect(container.querySelector(".thread-row__chip--unpushed")).toBeNull();
  });
});
