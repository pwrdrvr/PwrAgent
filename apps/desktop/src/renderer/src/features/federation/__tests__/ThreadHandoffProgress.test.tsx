import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadHandoffProgress } from "@pwragent/shared";
import {
  ThreadHandoffBandContext,
  ThreadHandoffComposerBand,
  ThreadHandoffToastCard,
} from "../ThreadHandoffProgress";
import { threadHandoffMeter } from "../thread-handoff-copy";
import {
  reduceThreadHandoffTransfers,
  type ThreadHandoffTransfer,
  type ThreadHandoffTransferEvent,
} from "../thread-handoff-transfer";
import { createThreadHandoffStore } from "../thread-handoff-store";
import { threadHandoffErrorMessage } from "../useThreadHandoffTransfers";

afterEach(() => {
  cleanup();
});

const HANDOFF = "0f0e0d0c-0b0a-4908-8706-050403020100";
const MIB = 1024 * 1024;

function events(reports: Partial<ThreadHandoffProgress>[]): ThreadHandoffTransferEvent[] {
  return [
    {
      type: "started",
      at: 0,
      handoffId: HANDOFF,
      sourceThreadId: "thread-1",
      threadKey: "codex:thread-1",
      title: "Release v0.17",
      targetLabel: "studio-mac / default",
      choice: { targetInstanceId: "pwr_studio", operation: "copy", targetRepositoryPath: "/src/PwrRoute" },
    },
    ...reports.map((report, index): ThreadHandoffTransferEvent => ({
      type: "progress",
      at: (index + 1) * 1000,
      progress: {
        handoffId: HANDOFF,
        sourceThreadId: "thread-1",
        phase: "send",
        link: "connected",
        cancelable: true,
        transport: "resumable",
        ...report,
      },
    })),
  ];
}

function transfer(reports: Partial<ThreadHandoffProgress>[]): ThreadHandoffTransfer {
  return events(reports).reduce(reduceThreadHandoffTransfers, {})[HANDOFF]!;
}

function storeWith(reports: Partial<ThreadHandoffProgress>[]) {
  const store = createThreadHandoffStore();
  events(reports).forEach(store.dispatch);
  return store;
}

function renderCard(value: ThreadHandoffTransfer) {
  const handlers = { onExpand: vi.fn(), onCancel: vi.fn(), onRetryNow: vi.fn() };
  render(<ThreadHandoffToastCard transfer={value} {...handlers} />);
  return handlers;
}

describe("thread handoff toast card", () => {
  it("names the step and lets the operator expand or cancel a live send", () => {
    const handlers = renderCard(transfer([{ bytesCommitted: 0, bytesTotal: 2 * MIB }, { bytesCommitted: MIB, bytesTotal: 2 * MIB }]));
    const eyebrow = screen.getByText("Sending");
    expect(eyebrow).toHaveTextContent("Sending · 50%");
    // The card is a polite live region: the step is announced, the ticking percent is not.
    expect(screen.getByText("· 50%", { exact: false })).toHaveAttribute("aria-live", "off");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    act(() => screen.getByRole("button", { name: "Show progress" }).click());
    act(() => screen.getByRole("button", { name: /Copying “Release v0.17”/ }).click());
    expect(handlers.onExpand).toHaveBeenCalledTimes(2);
    act(() => screen.getByRole("button", { name: "Cancel Copy" }).click());
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry Now" })).not.toBeInTheDocument();
  });

  it("holds a dropped send without calling it failed, and offers Retry Now", () => {
    const handlers = renderCard(transfer([
      { bytesCommitted: MIB, bytesTotal: 2 * MIB },
      { bytesCommitted: MIB, bytesTotal: 2 * MIB, link: "waiting", disconnectedAt: new Date().toISOString() },
    ]));
    expect(screen.getByText("Waiting for studio-mac / default")).toBeInTheDocument();
    expect(screen.getByText(/Nothing it already has is sent again/)).toBeInTheDocument();
    act(() => screen.getByRole("button", { name: "Retry Now" }).click());
    expect(handlers.onRetryNow).toHaveBeenCalledTimes(1);
  });

  it("withholds Cancel once the receiver may be creating the thread", () => {
    renderCard(transfer([{ phase: "import", cancelable: false }]));
    const cancel = screen.getByRole("button", { name: "Cancel Copy" });
    expect(cancel).toBeDisabled();
    expect(cancel).toHaveAttribute("data-tooltip", expect.stringContaining("is creating the thread"));
    expect(screen.getByText("studio-mac / default is creating the thread in a new worktree")).toBeInTheDocument();
  });
});

describe("thread handoff meter", () => {
  it("states the resume point once a send resumes", () => {
    const resumed = transfer([
      { bytesCommitted: MIB, bytesTotal: 2 * MIB },
      { bytesCommitted: Math.round(1.5 * MIB), bytesTotal: 2 * MIB, resumedFromBytes: MIB },
    ]);
    expect(threadHandoffMeter(resumed, { monotonic: 2000, wall: Date.now() }))
      .toMatch(/^1\.5 MB of 2\.0 MB · resumed at 1\.0 MB/);
  });

  it("times a dropped link with the app's live clock", () => {
    const lostAt = Date.parse("2026-11-05T10:00:00Z");
    const held = transfer([
      { bytesCommitted: MIB, bytesTotal: 2 * MIB, link: "waiting", disconnectedAt: new Date(lostAt).toISOString() },
    ]);
    expect(threadHandoffMeter(held, { monotonic: 0, wall: lostAt + 66_000 }))
      .toBe("1.0 MB of 2.0 MB on studio-mac / default · lost 1m 06s ago");
  });
});

describe("thread handoff composer band", () => {
  it("says why only the thread being sent is locked", () => {
    const store = storeWith([{ bytesCommitted: MIB, bytesTotal: 4 * MIB }]);
    const showProgress = vi.fn();
    const value = { store, showProgress };
    const { rerender } = render(
      <ThreadHandoffBandContext.Provider value={value}>
        <ThreadHandoffComposerBand threadKey="codex:other" />
      </ThreadHandoffBandContext.Provider>,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    rerender(
      <ThreadHandoffBandContext.Provider value={value}>
        <ThreadHandoffComposerBand threadKey="codex:thread-1" />
      </ThreadHandoffBandContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Copying to studio-mac / default");
    expect(screen.getByText("25%")).toHaveAttribute("aria-live", "off");
    act(() => screen.getByRole("button", { name: "Show Progress" }).click());
    expect(showProgress).toHaveBeenCalledWith(HANDOFF);
  });
});

describe("thread handoff error message", () => {
  it("shows the peer's cause without the invoke wrapper or handler prefix", () => {
    expect(threadHandoffErrorMessage(new Error(
      "Error invoking remote method 'federation:handoff-thread': Error: handler_failed: Destination creation could not be confirmed.",
    ))).toBe("Destination creation could not be confirmed.");
  });
});
