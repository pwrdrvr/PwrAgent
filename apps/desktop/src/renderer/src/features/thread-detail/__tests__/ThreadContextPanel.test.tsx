import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { BackendSummary, NavigationThreadSummary } from "@pwragent/shared";
import { ThreadContextPanel } from "../ThreadContextPanel";
import type { ContextTabId } from "../context-panels/context-tab";
import { collectEditedFileGroups } from "../edited-file-groups";

const HOVER_RAIL_REVEAL_DELAY_MS = 350;

// When the rail is open, the active tab's panel content renders. The
// default tab is "info"; its first (unconditional) section heading is a
// stable "the panel is revealed" signal. There is no separate panel title
// anymore — each panel's own section <h3> is the title.
const REVEALED_SIGNAL = "Linked directories";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const baseThread: NavigationThreadSummary = {
  id: "thread-1",
  title: "Thread",
  titleSource: "explicit",
  source: "codex",
  linkedDirectories: [],
  inbox: {
    inInbox: false,
  },
};

const baseBackend: BackendSummary = {
  kind: "codex",
  label: "OpenAI",
  available: true,
  account: {
    type: "chatgpt",
    email: "user@example.com",
    planType: "pro",
    requiresOpenaiAuth: false,
  },
  methods: ["thread/list", "thread/read"],
  capabilities: {
    listThreads: true,
    createThread: true,
    resumeThread: true,
    renameThread: true,
    readThread: true,
    startTurn: true,
    interruptTurn: true,
    steerTurn: true,
    transcriptPagination: true,
    toolUse: true,
    approvalRequests: true,
    multiDirectoryThreads: true,
  },
  executionModes: [
    {
      mode: "default",
      label: "Default",
      available: true,
      isDefault: true,
    },
  ],
  rateLimits: [
    {
      name: "5h limit",
      usedPercent: 7,
      windowMinutes: 300,
    },
    {
      name: "Weekly limit",
      usedPercent: 12,
      windowMinutes: 10_080,
    },
    {
      name: "gpt-5.3-codex-spark 5h limit",
      limitId: "gpt-5.3-codex-spark",
      usedPercent: 0,
      windowMinutes: 300,
    },
    {
      name: "gpt-5.3-codex-spark Weekly limit",
      limitId: "gpt-5.3-codex-spark",
      usedPercent: 0,
      windowMinutes: 10_080,
    },
  ],
};

type PanelOverrides = Partial<
  Pick<
    ComponentProps<typeof ThreadContextPanel>,
    | "activeTab"
    | "backends"
    | "desktopApi"
    | "pinned"
    | "thread"
    | "onRefreshNavigation"
    | "editedFileGroups"
    | "editedFilesDock"
    | "onEditedFilesDockChange"
  >
>;

function renderPanel(overrides: PanelOverrides = {}) {
  const onActiveTabChange = vi.fn<(tab: ContextTabId) => void>();
  const result = render(
    <ThreadContextPanel
      activeTab="info"
      backends={[baseBackend]}
      pinned={false}
      thread={baseThread}
      onActiveTabChange={onActiveTabChange}
      {...overrides}
    />,
  );
  return { ...result, onActiveTabChange };
}

const advanceHoverRevealDelay = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(HOVER_RAIL_REVEAL_DELAY_MS + 1);
  });
};

const mockRailRect = (rail: HTMLElement): void => {
  vi.spyOn(rail, "getBoundingClientRect").mockReturnValue({
    bottom: 800,
    height: 800,
    left: 620,
    right: 1000,
    top: 0,
    width: 380,
    x: 620,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
};

describe("ThreadContextPanel", () => {
  it("waits for hover intent before revealing the rail", async () => {
    vi.useFakeTimers();
    renderPanel();

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    expect(screen.queryByText(REVEALED_SIGNAL)).not.toBeInTheDocument();

    await advanceHoverRevealDelay();

    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();
  });

  it("does not reveal the rail after a drive-by hover", () => {
    vi.useFakeTimers();
    renderPanel();

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(HOVER_RAIL_REVEAL_DELAY_MS - 25);
    });
    fireEvent.mouseLeave(rail, { clientX: 600, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(HOVER_RAIL_REVEAL_DELAY_MS + 1);
    });

    expect(screen.queryByText(REVEALED_SIGNAL)).not.toBeInTheDocument();
  });

  it("reveals immediately when a collapsed rail tab is clicked", () => {
    vi.useFakeTimers();
    const { onActiveTabChange } = renderPanel();

    fireEvent.click(screen.getByRole("tab", { name: "Thread info" }));

    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();
    expect(onActiveTabChange).toHaveBeenCalledWith("info");
  });

  it("wires the tabs to a labelled tabpanel when the rail is open", () => {
    renderPanel({ pinned: true });

    const activeTab = screen.getByRole("tab", { name: "Thread info" });
    expect(activeTab).toHaveAttribute("aria-controls", "context-rail-panel");

    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "context-rail-panel");
    expect(panel).toHaveAttribute("aria-labelledby", activeTab.id);
  });

  it("renders persisted sub-agent cards with monitor usage", () => {
    renderPanel({
      activeTab: "subagents",
      pinned: true,
      thread: {
        ...baseThread,
        subAgents: [
          {
            monitorId: "monitor-2",
            task: "Watch CI until it completes.",
            status: "running",
            createdAt: 2000,
            updatedAt: 2500,
            preferredModel: "gpt-5.4-mini",
            monitorThreadId: "monitor-thread-2",
            lastMessage: "Lint is still running.",
            monitorUsage: {
              model: "gpt-5.4-mini",
              summary:
                "800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
              tokenUsage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                uncachedInputTokens: 800,
                outputTokens: 50,
                reasoningOutputTokens: 10,
                totalTokens: 1060,
              },
              cost: {
                model: "gpt-5.4-mini",
                totalUsd: 0.00084,
              },
            },
          },
          {
            monitorId: "monitor-1",
            task: "Older monitor.",
            status: "success",
            createdAt: 1000,
            updatedAt: 1500,
            completedAt: 1500,
          },
        ],
      },
    });

    expect(screen.getByText("Watch CI until it completes.")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Lint is still running.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Monitor usage: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent(
      "Watch CI until it completes.",
    );
    // Every card shows a labeled start time; the completed one also shows
    // the optional end time.
    expect(screen.getAllByText("Started")).toHaveLength(2);
    expect(screen.getByText("Ended")).toBeInTheDocument();

    // Details (renamed from the disabled History button) opens a modal with
    // the request, latest message, model, and token/pricing breakdown.
    const detailsButtons = screen.getAllByRole("button", { name: "Details" });
    expect(detailsButtons[0]).toBeEnabled();
    detailsButtons[0]!.focus();
    fireEvent.click(detailsButtons[0]!);
    const dialog = screen.getByRole("dialog");
    const modal = within(dialog);
    expect(
      modal.getByRole("heading", { level: 2, name: "Watch CI until it completes." }),
    ).toBeInTheDocument();
    expect(modal.getByText("Latest message")).toBeInTheDocument();
    expect(modal.getByText("Lint is still running.")).toBeInTheDocument();
    expect(modal.getByText("Tokens & pricing")).toBeInTheDocument();
    expect(modal.getByText("gpt-5.4-mini")).toBeInTheDocument();
    expect(modal.getByText("1,060")).toBeInTheDocument();

    // Focus moves into the dialog on open and returns to the opener on close.
    const closeButton = modal.getByRole("button", { name: "Close" });
    expect(closeButton).toHaveFocus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(detailsButtons[0]).toHaveFocus();
  });

  it("labels review sub-agent usage separately from monitor usage", () => {
    renderPanel({
      activeTab: "subagents",
      pinned: true,
      thread: {
        ...baseThread,
        subAgents: [
          {
            monitorId: "review:turn-review-1",
            task: "Review changes against main",
            status: "running",
            createdAt: 2000,
            updatedAt: 2500,
            monitorThreadId: "thread-1",
            monitorTurnId: "turn-review-1",
            monitorUsage: {
              summary: "800 uncached in · 200 cached · 50 out",
              tokenUsage: {
                inputTokens: 1000,
                cachedInputTokens: 200,
                uncachedInputTokens: 800,
                outputTokens: 50,
                totalTokens: 1050,
              },
            },
          },
        ],
      },
    });

    expect(
      screen.getByText("Review usage: 800 uncached in · 200 cached · 50 out"),
    ).toBeInTheDocument();
  });

  it("moves focus between tabs with Arrow keys (roving tablist)", () => {
    renderPanel({ pinned: true });

    const info = screen.getByRole("tab", { name: "Thread info" });
    const edits = screen.getByRole("tab", { name: "Edits" });
    info.focus();
    expect(document.activeElement).toBe(info);

    fireEvent.keyDown(info, { key: "ArrowDown" });
    expect(document.activeElement).toBe(edits);

    fireEvent.keyDown(edits, { key: "ArrowUp" });
    expect(document.activeElement).toBe(info);

    fireEvent.keyDown(info, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Provider status" }),
    );
  });

  it("hides the hover rail when document mouse movement resumes outside the rail", async () => {
    vi.useFakeTimers();
    renderPanel();

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    await advanceHoverRevealDelay();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();

    fireEvent.mouseMove(document, { clientX: 600, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.queryByText(REVEALED_SIGNAL)).not.toBeInTheDocument();
  });

  it("polls the window pointer and closes when the cursor remains outside the rail", async () => {
    vi.useFakeTimers();
    const getWindowPointerSnapshot = vi
      .fn()
      .mockResolvedValueOnce({
        contentBounds: {
          height: 800,
          width: 1000,
          x: 100,
          y: 100,
        },
        cursor: {
          x: 1080,
          y: 220,
        },
        windowFocused: false,
      })
      .mockResolvedValue({
        contentBounds: {
          height: 800,
          width: 1000,
          x: 100,
          y: 100,
        },
        cursor: {
          x: 700,
          y: 220,
        },
        windowFocused: false,
      });

    renderPanel({ desktopApi: { getWindowPointerSnapshot } });

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    await advanceHoverRevealDelay();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_701);
    });

    expect(getWindowPointerSnapshot).toHaveBeenCalled();
    expect(screen.queryByText(REVEALED_SIGNAL)).not.toBeInTheDocument();
  });

  it("keeps the hover rail open while the polled cursor remains inside the rail", async () => {
    vi.useFakeTimers();
    const getWindowPointerSnapshot = vi.fn(async () => ({
      contentBounds: {
        height: 800,
        width: 1000,
        x: 100,
        y: 100,
      },
      cursor: {
        x: 1080,
        y: 220,
      },
      windowFocused: false,
    }));

    renderPanel({ desktopApi: { getWindowPointerSnapshot } });

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    await advanceHoverRevealDelay();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(getWindowPointerSnapshot).toHaveBeenCalled();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();
  });

  it("keeps the hover rail open when a transient leave is still inside the opened rail", async () => {
    vi.useFakeTimers();
    renderPanel();

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    await advanceHoverRevealDelay();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();

    fireEvent.mouseLeave(rail, { clientX: 980, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();
  });

  it("hides the hover rail after the mouse leaves the opened rail", async () => {
    vi.useFakeTimers();
    renderPanel();

    const rail = screen.getByLabelText("Thread context");
    mockRailRect(rail);

    fireEvent.mouseEnter(rail, { clientX: 980, clientY: 120 });
    await advanceHoverRevealDelay();
    expect(screen.getByText(REVEALED_SIGNAL)).toBeInTheDocument();

    fireEvent.mouseLeave(rail, { clientX: 600, clientY: 120 });
    act(() => {
      vi.advanceTimersByTime(301);
    });

    expect(screen.queryByText(REVEALED_SIGNAL)).not.toBeInTheDocument();
  });

  it("shows path tooltips on linked directory labels and kind badges", () => {
    renderPanel({
      pinned: true,
      thread: {
        ...baseThread,
        linkedDirectories: [
          {
            id: "worktree-dir",
            kind: "worktree",
            label: "PwrAgent",
            path: "/Users/huntharo/github/PwrAgent",
            worktreePath:
              "/Users/huntharo/github/PwrAgent/.worktrees/launchpad-pwragent-main-molpnvyk",
          },
          {
            id: "local-dir",
            kind: "local",
            label: "LocalOnly",
            path: "/Users/huntharo/github/PwrAgent",
          },
        ],
      },
    });

    fireEvent.mouseEnter(screen.getByLabelText("Path for PwrAgent"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "/Users/huntharo/github/PwrAgent",
    );

    fireEvent.mouseLeave(screen.getByLabelText("Path for PwrAgent"));
    fireEvent.mouseEnter(screen.getByLabelText("Path for worktree PwrAgent"));
    expect(screen.getByRole("tooltip")).toHaveTextContent("/Users/huntharo/github");
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "launchpad-pwragent-main-molpnvyk",
    );

    fireEvent.mouseLeave(screen.getByLabelText("Path for worktree PwrAgent"));
    fireEvent.mouseEnter(screen.getByLabelText("Path for local LocalOnly"));
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "/Users/huntharo/github/PwrAgent",
    );
  });

  it("shows regular and Spark rate limits together on the Provider status tab", () => {
    renderPanel({ activeTab: "providers", pinned: true });

    expect(screen.getByText(/5h limit: 93% left/)).toBeInTheDocument();
    expect(screen.getByText(/Weekly limit: 88% left/)).toBeInTheDocument();
    expect(screen.getByText(/Spark 5h limit: 100% left/)).toBeInTheDocument();
    expect(screen.getByText(/Spark Weekly limit: 100% left/)).toBeInTheDocument();
  });

  it("marks an ordinary thread as an Agent from the context panel", async () => {
    const setThreadAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
      agent: {
        name: "Thread",
        instructionLineCount: 0,
        instructionsTooLong: false,
        updatedAt: 1,
      },
    }));
    const onRefreshNavigation = vi.fn(async () => undefined);

    renderPanel({
      desktopApi: { setThreadAgent },
      pinned: true,
      onRefreshNavigation,
    });

    fireEvent.click(screen.getByRole("button", { name: "Mark as Agent" }));

    await waitFor(() => expect(setThreadAgent).toHaveBeenCalledTimes(1));
    expect(setThreadAgent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      agent: {
        name: "Thread",
      },
    });
    expect(onRefreshNavigation).toHaveBeenCalledOnce();
  });

  it("clears Agent metadata from the context panel", async () => {
    const setThreadAgent = vi.fn(async () => ({
      backend: "codex" as const,
      threadId: "thread-1",
    }));

    renderPanel({
      desktopApi: { setThreadAgent },
      pinned: true,
      thread: {
        ...baseThread,
        agent: {
          name: "Inbox Agent",
          instructionLineCount: 0,
          instructionsTooLong: false,
          updatedAt: 1,
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(setThreadAgent).toHaveBeenCalledTimes(1));
    expect(setThreadAgent).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      agent: null,
    });
  });

  it("labels Spark rate limits when Spark has usage", () => {
    renderPanel({
      activeTab: "providers",
      pinned: true,
      backends: [
        {
          ...baseBackend,
          rateLimits: baseBackend.rateLimits?.map((limit) =>
            limit.limitId === "gpt-5.3-codex-spark" && limit.windowMinutes === 300
              ? { ...limit, usedPercent: 2 }
              : limit,
          ),
        },
      ],
    });

    expect(screen.getByText(/Spark 5h limit: 98% left/)).toBeInTheDocument();
    expect(screen.getByText(/Spark Weekly limit: 100% left/)).toBeInTheDocument();
  });

  it("renders the Edits tab empty state when no edits accumulated", () => {
    renderPanel({ activeTab: "edits", pinned: true });

    expect(
      screen.getByText(/No uncommitted file edits yet/),
    ).toBeInTheDocument();
  });

  it("renders accumulated edit groups on the Edits tab and toggles the dock", () => {
    const groups = collectEditedFileGroups({
      entries: [
        {
          type: "activity",
          id: "live-diff-turn-1",
          summary: "Edited 1 file, +2, -0",
          details: [
            {
              id: "detail-1",
              kind: "write",
              label: "Update a.ts",
              path: "/repo/src/a.ts",
              fileDiff: {
                kind: "update",
                additions: 2,
                removals: 0,
                diff: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +1,2 @@\n+x\n+y\n",
              },
            },
          ],
          turn: { id: "turn-1" },
        },
      ],
    });
    const onEditedFilesDockChange = vi.fn();
    renderPanel({
      activeTab: "edits",
      pinned: true,
      editedFileGroups: groups,
      editedFilesDock: "sidebar",
      onEditedFilesDockChange,
    });

    expect(screen.getByRole("heading", { level: 3, name: "Edits" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Update a\.ts/ }),
    ).toBeInTheDocument();

    // Docked to the sidebar → the toggle offers to restore the
    // above-composer copy.
    fireEvent.click(screen.getByRole("button", { name: "Show above composer" }));
    expect(onEditedFilesDockChange).toHaveBeenCalledWith("above");
  });
});
