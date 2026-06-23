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
import type {
  BackendSummary,
  NavigationThreadSummary,
  ThreadPricingSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
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
    | "activeTurnId"
    | "backends"
    | "desktopApi"
    | "pinned"
    | "thread"
    | "onRefreshNavigation"
    | "onScrollToTurn"
    | "editedFileGroups"
    | "editedFilesDock"
    | "onEditedFilesDockChange"
    | "pricing"
    | "pricingDisplayOptions"
    | "threadPricingSummaryEnabled"
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
            agentName: "Poincare",
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
    expect(screen.getByText("Poincare")).toBeInTheDocument();
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
    expect(modal.getByText("Name")).toBeInTheDocument();
    expect(modal.getByText("Poincare")).toBeInTheDocument();
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

  it("labels Codex native sub-agent usage separately from monitor usage", () => {
    renderPanel({
      activeTab: "subagents",
      pinned: true,
      thread: {
        ...baseThread,
        subAgents: [
          {
            monitorId: "codex-native:019ed7df-5876-7882-9b75-7fd647372da7",
            task: "Check PR status",
            status: "success",
            createdAt: 2000,
            completedAt: 3000,
            updatedAt: 2500,
            agentName: "Peirce",
            lastMessage: "PR #783 is open and all required checks are passing.",
            monitorThreadId: "019ed7df-5876-7882-9b75-7fd647372da7",
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
      screen.getByText("Codex usage: 800 uncached in · 200 cached · 50 out"),
    ).toBeInTheDocument();
    expect(screen.getByText("Peirce")).toBeInTheDocument();
    expect(
      screen.getByText("Spawned by Codex native spawnAgent."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("PR #783 is open and all required checks are passing."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Monitor usage: 800 uncached in · 200 cached · 50 out"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    const modal = within(screen.getByRole("dialog"));
    expect(modal.getByText("Source")).toBeInTheDocument();
    expect(modal.getByText("Codex native spawnAgent")).toBeInTheDocument();
  });

  it("does not duplicate the Codex native source line while running", () => {
    renderPanel({
      activeTab: "subagents",
      pinned: true,
      thread: {
        ...baseThread,
        subAgents: [
          {
            monitorId: "codex-native:019ed7df-5876-7882-9b75-7fd647372da7",
            task: "Check PR status",
            status: "running",
            createdAt: 2000,
            updatedAt: 2500,
            monitorThreadId: "019ed7df-5876-7882-9b75-7fd647372da7",
            lastMessage: "Spawned by Codex native spawnAgent.",
          },
        ],
      },
    });

    expect(screen.getAllByText("Spawned by Codex native spawnAgent.")).toHaveLength(
      1,
    );
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

  it("shows the Pricing tab by default", () => {
    renderPanel({
      activeTab: "pricing",
      pinned: true,
    });

    expect(screen.getByRole("tab", { name: "Pricing" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 3, name: "Pricing" }),
    ).toBeInTheDocument();
  });

  it("hides the Pricing tab while the experimental flag is off", () => {
    renderPanel({
      activeTab: "pricing",
      pinned: true,
      threadPricingSummaryEnabled: false,
    });

    expect(screen.queryByRole("tab", { name: "Pricing" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { level: 3, name: "Pricing" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Thread info" })).toBeInTheDocument();
  });

  it("renders cached pricing totals and per-turn model settings", () => {
    const summary: ThreadPricingSummary = {
      backend: "codex",
      threadId: "thread-1",
      currency: "USD",
      inputTokens: 2_000,
      uncachedInputTokens: 1_500,
      cachedInputTokens: 500,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 2_420,
      totalCostMicros: 9_500,
      usageLineCount: 1,
      pricedUsageLineCount: 1,
      unpricedUsageLineCount: 0,
      provider: "openai",
      updatedAt: 1_800_000_000_000,
    };
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "codex:thread-1:turn-1:turn:item-1",
      threadId: "thread-1",
      turnId: "turn-1",
      scope: "turn",
      source: "hydration",
      sourceItemId: "item-1",
      status: "finalized",
      model: "gpt-5.5",
      reasoningEffort: "high",
      fastMode: true,
      serviceTier: "priority",
      settingsSource: "turn-context",
      settingsConfidence: "exact",
      inputTokens: 2_000,
      uncachedInputTokens: 1_500,
      cachedInputTokens: 500,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 2_420,
      priceStatus: "priced",
      currency: "USD",
      cumulativeTotalCostMicros: 42_000,
      uncachedInputCostMicros: 7_500,
      cachedInputCostMicros: 500,
      outputCostMicros: 1_500,
      totalCostMicros: 9_500,
      provider: "openai",
      pricingCatalogId: "openai-api",
      pricingCatalogVersion: "2026-06-16",
      pricingRateId: "openai-api:2026-06-16:gpt-5.5:priority",
      createdAt: 1_800_000_000_000,
      completedAt: 1_800_000_001_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [summary],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByRole("heading", { level: 3, name: "Pricing" })).toBeInTheDocument();
    expect(screen.getByText("$0.010")).toBeInTheDocument();
    expect(screen.getByText("gpt-5.5 · high · Fast")).toBeInTheDocument();
    expect(
      screen.queryByText("gpt-5.5 · high · Fast · priority"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("1,500 uncached in · 500 cached · 300 out (120 reasoning)"),
    ).toBeInTheDocument();
    expect(screen.getByText("$0.010 list price this turn")).toBeInTheDocument();
    expect(screen.getByText("Running total: $0.010 list price")).toBeInTheDocument();
  });

  it("renders Codex Credits as an optional pricing display unit", () => {
    const summary: ThreadPricingSummary = {
      backend: "codex",
      threadId: "thread-1",
      currency: "USD",
      inputTokens: 2_000,
      uncachedInputTokens: 1_500,
      cachedInputTokens: 500,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 2_420,
      totalCostMicros: 9_500,
      usageLineCount: 1,
      pricedUsageLineCount: 1,
      unpricedUsageLineCount: 0,
      provider: "openai",
      updatedAt: 1_800_000_000_000,
    };
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-1",
      threadId: "thread-1",
      turnId: "turn-1",
      scope: "turn",
      source: "hydration",
      status: "finalized",
      model: "gpt-5.5",
      reasoningEffort: "high",
      fastMode: true,
      serviceTier: "priority",
      inputTokens: 2_000,
      uncachedInputTokens: 1_500,
      cachedInputTokens: 500,
      outputTokens: 300,
      reasoningOutputTokens: 120,
      totalTokens: 2_420,
      priceStatus: "priced",
      currency: "USD",
      cumulativeTotalCostMicros: 42_000,
      uncachedInputCostMicros: 7_500,
      cachedInputCostMicros: 500,
      outputCostMicros: 1_500,
      totalCostMicros: 9_500,
      provider: "openai",
      createdAt: 1_800_000_000_000,
      completedAt: 1_800_000_001_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [summary],
      },
      pricingDisplayOptions: {
        codexCredits: true,
        usd: true,
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByText("$0.010 · 1.3 Codex Credits")).toBeInTheDocument();
    expect(screen.queryByText("$0.042 · 1.3 Codex Credits")).not.toBeInTheDocument();
    expect(
      screen.getByText("$0.010 list price this turn · 1.3 Codex Credits this turn"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Running total: $0.042 list price · 1.3 Codex Credits"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Running total: $0.010 list price · 1.3 Codex Credits"),
    ).toBeInTheDocument();
  });

  it("uses cumulative token gaps but ignores cumulative aggregate cost fields", () => {
    const summary: ThreadPricingSummary = {
      backend: "codex",
      threadId: "thread-1",
      currency: "USD",
      inputTokens: 722_086,
      uncachedInputTokens: 96_934,
      cachedInputTokens: 625_152,
      outputTokens: 3_601,
      reasoningOutputTokens: 255,
      totalTokens: 725_942,
      totalCostMicros: 749_421,
      usageLineCount: 3,
      pricedUsageLineCount: 3,
      unpricedUsageLineCount: 0,
      provider: "openai",
      updatedAt: 1_800_000_060_000,
    };
    const latestLine: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-latest",
      threadId: "thread-1",
      turnId: "turn-latest",
      scope: "turn",
      source: "hydration",
      status: "finalized",
      model: "gpt-5.5",
      inputTokens: 493_365,
      uncachedInputTokens: 76_981,
      cachedInputTokens: 416_384,
      outputTokens: 2_124,
      reasoningOutputTokens: 154,
      totalTokens: 495_643,
      priceStatus: "priced",
      currency: "USD",
      cumulativeCachedInputTokens: 70_463_104,
      cumulativeInputTokens: 73_251_863,
      cumulativeOutputTokens: 221_675,
      cumulativeReasoningOutputTokens: 37_030,
      cumulativeTotalCostMicros: 21_440_000,
      cumulativeTotalTokens: 73_510_568,
      cumulativeUncachedInputTokens: 2_788_759,
      uncachedInputCostMicros: 620_000,
      cachedInputCostMicros: 5_000,
      outputCostMicros: 45_000,
      totalCostMicros: 670_000,
      provider: "openai",
      createdAt: 1_800_000_060_000,
    };
    const monitorLine: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "monitor-line",
      threadId: "monitor-thread",
      parentThreadId: "thread-1",
      turnId: "monitor-turn",
      scope: "monitor",
      source: "monitor",
      status: "finalized",
      model: "gpt-5.4-mini",
      inputTokens: 162_816,
      uncachedInputTokens: 18_944,
      cachedInputTokens: 143_872,
      outputTokens: 1_150,
      reasoningOutputTokens: 55,
      totalTokens: 164_021,
      priceStatus: "priced",
      currency: "USD",
      uncachedInputCostMicros: 10_000,
      cachedInputCostMicros: 8_000,
      outputCostMicros: 12_421,
      totalCostMicros: 30_421,
      provider: "openai",
      createdAt: 1_800_000_030_000,
    };
    const previousLine: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-previous",
      threadId: "thread-1",
      turnId: "turn-previous",
      scope: "turn",
      source: "hydration",
      status: "finalized",
      model: "gpt-5.5",
      inputTokens: 65_905,
      uncachedInputTokens: 1_009,
      cachedInputTokens: 64_896,
      outputTokens: 327,
      reasoningOutputTokens: 46,
      totalTokens: 66_278,
      priceStatus: "priced",
      currency: "USD",
      cumulativeTotalCostMicros: 20_770_000,
      uncachedInputCostMicros: 30_000,
      cachedInputCostMicros: 1_000,
      outputCostMicros: 18_000,
      totalCostMicros: 49_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [latestLine, monitorLine, previousLine],
        summaries: [summary],
      },
      pricingDisplayOptions: {
        codexCredits: true,
        usd: true,
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByText("$56.98 · 1,424 Codex Credits estimated")).toBeInTheDocument();
    expect(screen.queryByText("$21.44 · 1,423 Codex Credits")).not.toBeInTheDocument();
    expect(
      screen.getByText("2,807,703 uncached, 70,606,976 cached"),
    ).toBeInTheDocument();
    expect(screen.getByText("222,825 (37,085 reasoning)")).toBeInTheDocument();
    expect(screen.getByText("Historical usage estimate")).toBeInTheDocument();
    expect(
      screen.getByText("$56.23 estimated list price · 1,406 Codex Credits estimated"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Running total: $56.98 list price · 1,424 Codex Credits (includes estimates)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Running total: $0.080 list price · 2 Codex Credits"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Running tokens: 2,788,759 uncached in · 70,463,104 cached · 221,675 out (37,030 reasoning)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Running total: $20.77 list price · 1.2 Codex Credits"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Running total: $0.049 list price · 1.2 Codex Credits")).toBeInTheDocument();
  });

  it("inserts estimated historical gap rows from unexplained cumulative token jumps", () => {
    const firstObservedLine: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-first-observed",
      threadId: "thread-1",
      turnId: "turn-first-observed",
      scope: "turn",
      source: "live",
      status: "pending",
      model: "gpt-5.5",
      serviceTier: "priority",
      fastMode: true,
      inputTokens: 150,
      uncachedInputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 160,
      priceStatus: "priced",
      currency: "USD",
      cumulativeInputTokens: 3_150,
      cumulativeCachedInputTokens: 2_050,
      cumulativeUncachedInputTokens: 1_100,
      cumulativeOutputTokens: 110,
      cumulativeReasoningOutputTokens: 20,
      cumulativeTotalTokens: 3_280,
      uncachedInputCostMicros: 10_000,
      cachedInputCostMicros: 1_000,
      outputCostMicros: 4_000,
      totalCostMicros: 15_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };
    const laterObservedLine: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-later-observed",
      threadId: "thread-1",
      turnId: "turn-later-observed",
      scope: "turn",
      source: "live",
      status: "pending",
      model: "gpt-5.5",
      serviceTier: "standard",
      fastMode: false,
      inputTokens: 50,
      uncachedInputTokens: 20,
      cachedInputTokens: 30,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      totalTokens: 55,
      priceStatus: "priced",
      currency: "USD",
      cumulativeInputTokens: 4_700,
      cumulativeCachedInputTokens: 3_080,
      cumulativeUncachedInputTokens: 1_620,
      cumulativeOutputTokens: 165,
      cumulativeReasoningOutputTokens: 20,
      cumulativeTotalTokens: 4_885,
      uncachedInputCostMicros: 1_000,
      cachedInputCostMicros: 100,
      outputCostMicros: 900,
      totalCostMicros: 2_000,
      provider: "openai",
      createdAt: 1_800_000_060_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [laterObservedLine, firstObservedLine],
        summaries: [
          {
            backend: "codex",
            cachedInputTokens: 80,
            currency: "USD",
            inputTokens: 200,
            outputTokens: 15,
            pricedUsageLineCount: 2,
            provider: "openai",
            reasoningOutputTokens: 0,
            threadId: "thread-1",
            totalCostMicros: 17_000,
            totalTokens: 215,
            uncachedInputTokens: 120,
            unpricedUsageLineCount: 0,
            updatedAt: 1_800_000_060_000,
            usageLineCount: 2,
          },
        ],
      },
      pricingDisplayOptions: {
        codexCredits: true,
        usd: true,
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByText("$0.032 · 0.4 Codex Credits estimated")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("4 (4 priced, 0 unpriced)");
    expect(screen.getAllByText("Historical usage estimate")).toHaveLength(2);
    expect(screen.getByText("1,000 uncached in · 2,000 cached · 100 out (20 reasoning)")).toBeInTheDocument();
    expect(screen.getByText("500 uncached in · 1,000 cached · 50 out")).toBeInTheDocument();
    expect(
      screen.getByText("$0.010 estimated list price · 0.2 Codex Credits estimated"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("$0.005 estimated list price · 0.1 Codex Credits estimated"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Running total: $0.032 list price · 0.4 Codex Credits (includes estimates)",
      ),
    ).toBeInTheDocument();
  });

  it("shows estimated cold and hot context replay counts on pricing cards", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-context-replays",
      threadId: "thread-1",
      turnId: "turn-context-replays",
      scope: "turn",
      source: "live",
      status: "finalized",
      model: "gpt-5.5",
      inputTokens: 550_000,
      uncachedInputTokens: 100_000,
      cachedInputTokens: 450_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      totalTokens: 552_500,
      priceStatus: "priced",
      currency: "USD",
      uncachedInputCostMicros: 500_000,
      cachedInputCostMicros: 225_000,
      outputCostMicros: 75_000,
      totalCostMicros: 800_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      activeTurnId: "turn-context-replays",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [
          {
            backend: "codex",
            cachedInputTokens: 450_000,
            currency: "USD",
            inputTokens: 550_000,
            outputTokens: 2_000,
            pricedUsageLineCount: 1,
            provider: "openai",
            reasoningOutputTokens: 500,
            threadId: "thread-1",
            totalCostMicros: 800_000,
            totalTokens: 552_500,
            uncachedInputTokens: 100_000,
            unpricedUsageLineCount: 0,
            updatedAt: 1_800_000_000_000,
            usageLineCount: 1,
          },
        ],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(
      screen.getByText(
        "Estimated cold context replays: 1 (100,000 uncached · $0.50)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated hot context replays: 5 (~90,000 cached avg; 450,000 cached bucket · $0.23)",
      ),
    ).toBeInTheDocument();
  });

  it("hides context replay estimates for inactive persisted pricing rows", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-inactive-context-replays",
      threadId: "thread-1",
      turnId: "turn-inactive-context-replays",
      scope: "turn",
      source: "live",
      status: "pending",
      model: "gpt-5.5",
      inputTokens: 550_000,
      uncachedInputTokens: 100_000,
      cachedInputTokens: 450_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      totalTokens: 552_500,
      priceStatus: "priced",
      currency: "USD",
      uncachedInputCostMicros: 500_000,
      cachedInputCostMicros: 225_000,
      outputCostMicros: 75_000,
      totalCostMicros: 800_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.queryByText(/Estimated cold context replays/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Estimated hot context replays/)).not.toBeInTheDocument();
  });

  it("does not add later uncached tail tokens to a cumulative live cold replay estimate", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-cumulative-live-context-replays",
      threadId: "thread-1",
      turnId: "turn-cumulative-live-context-replays",
      scope: "turn",
      source: "live",
      status: "pending",
      model: "gpt-5.5",
      inputTokens: 2_014_925,
      uncachedInputTokens: 205_261,
      cachedInputTokens: 1_809_664,
      outputTokens: 2_454,
      reasoningOutputTokens: 417,
      totalTokens: 2_017_796,
      priceStatus: "priced",
      currency: "USD",
      cumulativeInputTokens: 7_633_951,
      cumulativeCachedInputTokens: 7_219_456,
      cumulativeUncachedInputTokens: 414_495,
      cumulativeOutputTokens: 9_000,
      cumulativeReasoningOutputTokens: 1_200,
      cumulativeTotalTokens: 7_644_151,
      uncachedInputCostMicros: 2_570_000,
      cachedInputCostMicros: 905_000,
      outputCostMicros: 100_000,
      totalCostMicros: 3_575_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      activeTurnId: "turn-cumulative-live-context-replays",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(
      screen.getByText(
        "Estimated cold context replays: 1 (201,074 uncached · $2.52)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated hot context replays: 9 (~201,074 cached avg; 1,809,664 cached bucket · $0.91)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "Estimated cold context replays: 1 (205,261 uncached · $2.57)",
      ),
    ).not.toBeInTheDocument();
  });

  it("splits replay estimates that exceed a plausible context window size", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-large-context-replays",
      threadId: "thread-1",
      turnId: "turn-large-context-replays",
      scope: "turn",
      source: "live",
      status: "finalized",
      model: "gpt-5.5",
      inputTokens: 3_714_407,
      uncachedInputTokens: 453_351,
      cachedInputTokens: 3_261_056,
      outputTokens: 13_156,
      reasoningOutputTokens: 4_891,
      totalTokens: 3_732_454,
      priceStatus: "priced",
      currency: "USD",
      uncachedInputCostMicros: 2_266_755,
      cachedInputCostMicros: 1_630_528,
      outputCostMicros: 543_000,
      totalCostMicros: 4_440_283,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      activeTurnId: "turn-large-context-replays",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(
      screen.getByText(
        "Estimated cold context replays: 2 (~226,676 uncached avg; 453,351 uncached bucket · $2.27)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated hot context replays: 15 (~217,404 cached avg; 3,261,056 cached bucket · $1.64)",
      ),
    ).toBeInTheDocument();
  });

  it("honors pricing display options for replay estimate costs", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-replay-display-options",
      threadId: "thread-1",
      turnId: "turn-replay-display-options",
      scope: "turn",
      source: "live",
      status: "finalized",
      model: "gpt-5.5",
      inputTokens: 550_000,
      uncachedInputTokens: 100_000,
      cachedInputTokens: 450_000,
      outputTokens: 2_000,
      reasoningOutputTokens: 500,
      totalTokens: 552_500,
      priceStatus: "priced",
      currency: "USD",
      uncachedInputCostMicros: 500_000,
      cachedInputCostMicros: 225_000,
      outputCostMicros: 75_000,
      totalCostMicros: 800_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    const { rerender } = renderPanel({
      activeTab: "pricing",
      activeTurnId: "turn-replay-display-options",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [],
      },
      pricingDisplayOptions: {
        codexCredits: true,
        usd: false,
      },
      threadPricingSummaryEnabled: true,
    });

    expect(
      screen.getByText(
        "Estimated cold context replays: 1 (100,000 uncached · 13 Codex Credits)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated hot context replays: 5 (~90,000 cached avg; 450,000 cached bucket · 5.6 Codex Credits)",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\$0\.50/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\$0\.23/)).not.toBeInTheDocument();

    rerender(
      <ThreadContextPanel
        activeTurnId="turn-replay-display-options"
        activeTab="pricing"
        backends={[baseBackend]}
        onActiveTabChange={() => {}}
        pinned
        pricing={{
          lines: [line],
          summaries: [],
        }}
        pricingDisplayOptions={{
          codexCredits: true,
          usd: true,
        }}
        thread={baseThread}
        threadPricingSummaryEnabled
      />,
    );

    expect(
      screen.getByText(
        "Estimated cold context replays: 1 (100,000 uncached · $0.50 · 13 Codex Credits)",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated hot context replays: 5 (~90,000 cached avg; 450,000 cached bucket · $0.23 · 5.6 Codex Credits)",
      ),
    ).toBeInTheDocument();
  });

  it("does not estimate context replays for historical gap rows", () => {
    const line: ThreadUsageLineRecord = {
      backend: "codex",
      usageLineId: "line-with-gap",
      threadId: "thread-1",
      turnId: "turn-with-gap",
      scope: "turn",
      source: "live",
      status: "pending",
      model: "gpt-5.5",
      inputTokens: 150,
      uncachedInputTokens: 100,
      cachedInputTokens: 50,
      outputTokens: 10,
      reasoningOutputTokens: 0,
      totalTokens: 160,
      priceStatus: "priced",
      currency: "USD",
      cumulativeInputTokens: 300_150,
      cumulativeCachedInputTokens: 200_050,
      cumulativeUncachedInputTokens: 100_100,
      cumulativeOutputTokens: 10,
      cumulativeReasoningOutputTokens: 0,
      cumulativeTotalTokens: 300_160,
      uncachedInputCostMicros: 1_000,
      cachedInputCostMicros: 100,
      outputCostMicros: 900,
      totalCostMicros: 2_000,
      provider: "openai",
      createdAt: 1_800_000_000_000,
    };

    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [line],
        summaries: [],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByText("Historical usage estimate")).toBeInTheDocument();
    expect(screen.queryByText(/cold context replays/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hot context replays/)).not.toBeInTheDocument();
  });

  it("makes pricing row timestamps scroll the transcript to their turn", () => {
    const onScrollToTurn = vi.fn();

    renderPanel({
      activeTab: "pricing",
      onScrollToTurn,
      pinned: true,
      pricing: {
        lines: [
          {
            backend: "codex",
            cachedInputCostMicros: 0,
            cachedInputTokens: 0,
            createdAt: 1_800_000_000_000,
            currency: "USD",
            inputTokens: 100,
            outputCostMicros: 0,
            outputTokens: 10,
            priceStatus: "priced",
            provider: "openai",
            reasoningOutputTokens: 0,
            scope: "turn",
            source: "hydration",
            status: "finalized",
            threadId: "thread-1",
            totalCostMicros: 1_000,
            totalTokens: 110,
            turnId: "turn-1",
            uncachedInputCostMicros: 0,
            uncachedInputTokens: 100,
            usageLineId: "line-1",
          },
        ],
        summaries: [
          {
            backend: "codex",
            cachedInputTokens: 0,
            currency: "USD",
            inputTokens: 100,
            outputTokens: 10,
            pricedUsageLineCount: 1,
            provider: "openai",
            reasoningOutputTokens: 0,
            threadId: "thread-1",
            totalCostMicros: 1_000,
            totalTokens: 110,
            uncachedInputTokens: 100,
            unpricedUsageLineCount: 0,
            updatedAt: 1_800_000_000_000,
            usageLineCount: 1,
          },
        ],
      },
      threadPricingSummaryEnabled: true,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: /Scroll the transcript to this turn/,
      }),
    );

    expect(onScrollToTurn).toHaveBeenCalledWith("turn-1", 1_800_000_000_000);
  });

  it("summarizes pricing rows when provider summaries are absent", () => {
    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [
          {
            backend: "codex",
            cachedInputCostMicros: 50,
            cachedInputTokens: 500,
            createdAt: 1_800_000_000_000,
            currency: "USD",
            inputTokens: 2_000,
            model: "gpt-5.5",
            outputCostMicros: 500,
            outputTokens: 300,
            priceStatus: "priced",
            provider: "openai",
            reasoningOutputTokens: 50,
            scope: "monitor",
            source: "monitor",
            status: "finalized",
            threadId: "monitor-thread-1",
            totalCostMicros: 1_250,
            totalTokens: 2_350,
            uncachedInputCostMicros: 700,
            uncachedInputTokens: 1_500,
            usageLineId: "monitor-line-1",
          },
        ],
        summaries: [],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.queryByText("No usage pricing recorded yet.")).not.toBeInTheDocument();
    expect(screen.getAllByText("$0.002")[0]).toBeInTheDocument();
    expect(document.body).toHaveTextContent("1 (1 priced, 0 unpriced)");
    expect(screen.getByText("Sub-agent usage")).toBeInTheDocument();
  });

  it("labels legacy live rows without cumulative context as historical summaries", () => {
    renderPanel({
      activeTab: "pricing",
      pinned: true,
      pricing: {
        lines: [
          {
            backend: "codex",
            cachedInputCostMicros: 7_000_000,
            cachedInputTokens: 70_463_104,
            createdAt: 1_800_000_000_000,
            currency: "USD",
            inputTokens: 73_251_863,
            model: "gpt-5.5",
            outputCostMicros: 42_000_000,
            outputTokens: 221_675,
            priceStatus: "priced",
            provider: "openai",
            reasoningOutputTokens: 37_030,
            scope: "turn",
            source: "live",
            status: "pending",
            threadId: "thread-1",
            totalCostMicros: 55_830_000,
            totalTokens: 73_473_538,
            turnId: "turn-legacy",
            uncachedInputCostMicros: 6_830_000,
            uncachedInputTokens: 2_788_759,
            usageLineId: "line-legacy",
          },
        ],
        summaries: [
          {
            backend: "codex",
            cachedInputTokens: 70_463_104,
            currency: "USD",
            inputTokens: 73_251_863,
            outputTokens: 221_675,
            pricedUsageLineCount: 1,
            provider: "openai",
            reasoningOutputTokens: 37_030,
            threadId: "thread-1",
            totalCostMicros: 55_830_000,
            totalTokens: 73_473_538,
            uncachedInputTokens: 2_788_759,
            unpricedUsageLineCount: 0,
            updatedAt: 1_800_000_000_000,
            usageLineCount: 1,
          },
        ],
      },
      threadPricingSummaryEnabled: true,
    });

    expect(screen.getByText("Historical usage summary")).toBeInTheDocument();
    expect(screen.getByText("$55.83 list price")).toBeInTheDocument();
    expect(screen.queryByText("$55.83 list price this turn")).not.toBeInTheDocument();
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
