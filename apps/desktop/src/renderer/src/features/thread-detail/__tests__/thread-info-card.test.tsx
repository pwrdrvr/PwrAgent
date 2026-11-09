import "@testing-library/jest-dom/vitest";
import type {
  NavigationQueryPage,
  NavigationQueryRequest,
  NavigationRow,
  NavigationThreadSummary,
  ReadThreadFamilyPricingRequest,
  ReadThreadFamilyPricingResponse,
  ThreadFamilyPricingMember,
} from "@pwragent/shared";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopApi } from "../../../lib/desktop-api";
import { ThreadLinkProvider } from "../../../lib/thread-links";
import { ThreadChip } from "../ThreadChip";
import {
  clearThreadInfoCostCache,
  readThreadInfoCost,
  threadInfoCost,
  threadInfoFacts,
  threadInfoOwner,
} from "../thread-info";

const THREAD_ID = "7f3c91d2-4b8e-7a10-9c5d-2e6f0a1b3c48";
const HOUR = 60 * 60 * 1000;

function summary(overrides: Partial<NavigationThreadSummary> = {}): NavigationThreadSummary {
  return {
    id: THREAD_ID,
    title: "Archived worktree cleanup flake",
    titleSource: "generated",
    source: "codex",
    linkedDirectories: [],
    inbox: { unread: false },
    createdAt: Date.now() - 11 * HOUR,
    updatedAt: Date.now() - 18 * 60 * 1000,
    gitBranch: "fix/archived-worktree-reaudit",
    model: "gpt-6.1-sol",
    reasoningEffort: "xhigh",
    executionMode: "full-access",
    threadStatus: "idle",
    ...overrides,
  } as NavigationThreadSummary;
}

function member(overrides: Partial<ThreadFamilyPricingMember>): ThreadFamilyPricingMember {
  return {
    backend: "codex", threadId: THREAD_ID, title: "Member", self: false, active: false,
    totalCostMicros: 0, usageLineCount: 1, unpricedUsageLineCount: 0,
    ...overrides,
  };
}

function family(members: ThreadFamilyPricingMember[]): ReadThreadFamilyPricingResponse {
  return { members, readAt: 0 } as ReadThreadFamilyPricingResponse;
}

type ReadFamily = NonNullable<DesktopApi["readThreadFamilyPricing"]>;
type QueryPage = NonNullable<DesktopApi["getNavigationQueryPage"]>;
let api: {
  readThreadFamilyPricing: ReturnType<typeof vi.fn<ReadFamily>>;
  getNavigationQueryPage: ReturnType<typeof vi.fn<QueryPage>>;
};

beforeEach(() => {
  clearThreadInfoCostCache();
  api = {
    readThreadFamilyPricing: vi.fn<ReadFamily>(async (_request: ReadThreadFamilyPricingRequest) => family([
      member({ self: true, totalCostMicros: 3_160_000 }),
      member({ threadId: "child-1", totalCostMicros: 4_000_000 }),
      member({ threadId: "child-2", totalCostMicros: 1_870_000 }),
    ])),
    getNavigationQueryPage: vi.fn<QueryPage>(async (_request: NavigationQueryRequest): Promise<NavigationQueryPage> => ({
      entries: [], complete: true, coverage: { state: "complete" },
    }) as unknown as NavigationQueryPage),
  };
  (window as Window & { pwragent?: unknown }).pwragent = api;
});

afterEach(() => {
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

function renderChip(link: { instanceId?: string; instanceLabel?: string }, threads: NavigationThreadSummary[]) {
  return render(
    <ThreadLinkProvider onShowThread={vi.fn()} threads={threads}>
      <ThreadChip
        fallbackLabel="Archived worktree cleanup flake"
        link={{ backend: "codex", threadId: THREAD_ID, title: "", ...link }}
        onOpen={vi.fn()}
      />
    </ThreadLinkProvider>,
  );
}

async function openCard() {
  await act(async () => {
    fireEvent.focus(screen.getByRole("button", { name: /^Open thread/ }));
    await Promise.resolve();
    await Promise.resolve();
  });
  return screen.getByRole("tooltip");
}

describe("thread info helpers", () => {
  it("reads running, offline and settings from a row", () => {
    expect(threadInfoFacts(summary({ threadStatus: "active" }))).toMatchObject({
      running: true, subAgentWorking: false, model: "gpt-6.1-sol", reasoningEffort: "xhigh",
      executionMode: "full-access", ownerOffline: false,
    });
    expect(threadInfoFacts(summary({ hasActiveSubAgent: true })).subAgentWorking).toBe(true);
    expect(threadInfoFacts(summary({ hasBackgroundTasks: true })).running).toBe(true);
    expect(threadInfoFacts(summary({ federation: {
      ref: { backend: "codex", threadId: THREAD_ID, target: { scope: "remote", instanceId: "lab" } },
      instanceLabel: "lab-mini / default", peerStatus: "disconnected",
    } })).ownerOffline).toBe(true);
  });

  it("totals a family and marks a floor", () => {
    expect(threadInfoCost(family([
      member({ self: true, totalCostMicros: 1_000_000 }),
      member({ threadId: "c", totalCostMicros: 2_000_000, unpricedUsageLineCount: 1 }),
    ]))).toEqual({ state: "ready", ownMicros: 1_000_000, totalMicros: 3_000_000, subThreadCount: 1, partial: true });
    expect(threadInfoCost(family([member({ self: true, unavailable: true })]))).toEqual({ state: "unavailable" });
  });

  it("asks the link's owner, else the window's", () => {
    const window = { scope: "remote" as const, instanceId: "peer" };
    expect(threadInfoOwner({ backend: "codex", threadId: "t", instanceId: "lab" }, window))
      .toEqual({ scope: "remote", instanceId: "lab" });
    expect(threadInfoOwner({ backend: "codex", threadId: "t" }, window)).toBe(window);
    expect(threadInfoOwner({ backend: "codex", threadId: "t" }, undefined)).toBeUndefined();
  });

  it("reads cost once per thread within 30 seconds", async () => {
    const target = { backend: "codex" as const, threadId: THREAD_ID };
    await readThreadInfoCost(api, target, undefined, 1_000);
    await readThreadInfoCost(api, target, undefined, 20_000);
    expect(api.readThreadFamilyPricing).toHaveBeenCalledTimes(1);
    await readThreadInfoCost(api, target, undefined, 40_000);
    expect(api.readThreadFamilyPricing).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer cost read when an older one fails", async () => {
    const target = { backend: "codex" as const, threadId: THREAD_ID };
    let fail: (error: Error) => void = () => {};
    api.readThreadFamilyPricing.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const older = readThreadInfoCost(api, target, undefined, 1_000);
    const newer = readThreadInfoCost(api, target, undefined, 40_000);
    fail(new Error("offline"));
    expect(await older).toEqual({ state: "unavailable" });
    expect(await readThreadInfoCost(api, target, undefined, 41_000)).toBe(await newer);
    expect(api.readThreadFamilyPricing).toHaveBeenCalledTimes(2);
  });
});

describe("thread chip hover card", () => {
  it("resolves and caches an unmounted transcript link before hover or click", async () => {
    const ownerRow = { ...summary({ title: "Owner's actual title" }),
      ref: { backend: "codex", threadId: THREAD_ID } } as NavigationRow;
    api.getNavigationQueryPage.mockResolvedValue({ entries: [{ row: ownerRow }] } as unknown as NavigationQueryPage);
    const show = vi.fn();
    const chip = (messageId?: string) => <ThreadChip fallbackLabel="Old transcript label" onOpen={show}
      link={{ backend: "codex", threadId: THREAD_ID, title: "", instanceId: "lab", messageId }} />;
    const view = render(<ThreadLinkProvider onShowThread={show} threads={[]}>{chip("message-1")}{chip()}</ThreadLinkProvider>);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Open thread Owner's actual title" })).toHaveLength(2));
    expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(1);
    expect(api.readThreadFamilyPricing).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "Open thread Owner's actual title" })[1]!);
    expect(show.mock.lastCall?.[0].messageId).toBeUndefined();
    view.rerender(<ThreadLinkProvider onShowThread={show} threads={[]}><span>Another transcript</span></ThreadLinkProvider>);
    view.rerender(<ThreadLinkProvider onShowThread={show} threads={[]}>{chip()}</ThreadLinkProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Open thread Owner's actual title" })).toBeInTheDocument());
    const card = await openCard();
    expect(card).toHaveTextContent("gpt-6.1-sol");
    expect(card).not.toHaveTextContent("not found");
    expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(1);
  });

  it("keeps a loaded navigation title when an older encounter read settles later", async () => {
    let finish!: (page: NavigationQueryPage) => void;
    api.getNavigationQueryPage.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const chip = <ThreadChip link={{ backend: "codex", threadId: THREAD_ID, title: "" }} onOpen={vi.fn()} />;
    const view = render(<ThreadLinkProvider onShowThread={vi.fn()} threads={[]}>{chip}</ThreadLinkProvider>);
    view.rerender(<ThreadLinkProvider onShowThread={vi.fn()} threads={[summary({ title: "New navigation title" })]}>
      {chip}
    </ThreadLinkProvider>);
    await act(async () => finish({ entries: [{ row: {
      ...summary({ title: "Old encounter title" }), ref: { backend: "codex", threadId: THREAD_ID },
    } }] } as NavigationQueryPage));
    expect(screen.getByRole("button", { name: "Open thread New navigation title" })).toBeInTheDocument();
    expect(api.getNavigationQueryPage).toHaveBeenCalledTimes(1);
  });

  it("shows a loaded thread's settings, family cost and timeline", async () => {
    renderChip({}, [summary()]);
    const card = await openCard();

    expect(card).toHaveClass("pr-status-card", "thread-info-card");
    expect(card).toHaveTextContent("Archived worktree cleanup flake");
    expect(card).toHaveTextContent("This machine");
    expect(card).toHaveTextContent(THREAD_ID);
    expect(card).toHaveTextContent("fix/archived-worktree-reaudit");
    expect(card).toHaveTextContent("Idle");
    expect(card).toHaveTextContent("OpenAI");
    expect(card).toHaveTextContent("gpt-6.1-sol · xhigh");
    expect(card).toHaveTextContent("Full Access");
    expect(card).toHaveTextContent("$9.03");
    expect(card).toHaveTextContent("with 2 sub-threads");
    expect(card).toHaveTextContent("$3.16");
    expect(card).toHaveTextContent("11h ago");
    expect(card).toHaveTextContent("18m ago");
    expect(screen.getByRole("button", { name: /^Open thread/ }))
      .toHaveAttribute("aria-describedby", card.id);
    // A loaded row needs no navigation read.
    expect(api.getNavigationQueryPage).not.toHaveBeenCalled();
    expect(api.readThreadFamilyPricing).toHaveBeenCalledWith({ backend: "codex", threadId: THREAD_ID });
  });

  it("reads a peer thread the window has not loaded from its owner", async () => {
    api.getNavigationQueryPage.mockResolvedValueOnce({ entries: [{ row: {
      ref: { backend: "codex", threadId: THREAD_ID, ownerInstanceId: "lab" },
      id: THREAD_ID, source: "codex", title: "Archived worktree cleanup flake", titleSource: "generated",
      threadStatus: "active", model: "gpt-6.1-sol", reasoningEffort: "high", executionMode: "default",
      linkedDirectories: [], inbox: { unread: false }, ordinaryChildCount: 0, nativeSubAgentGroupPresent: false,
    } as unknown as NavigationRow }] } as unknown as NavigationQueryPage);
    api.readThreadFamilyPricing.mockResolvedValueOnce(family([member({ self: true, totalCostMicros: 840_000 })]));
    renderChip({ instanceId: "lab", instanceLabel: "lab-mini / default" }, []);
    const card = await openCard();

    expect(api.getNavigationQueryPage).toHaveBeenCalledWith(expect.objectContaining({
      inventory: "owner", federationTarget: { scope: "remote", instanceId: "lab" },
      query: { kind: "exact", identities: [{ backend: "codex", threadId: THREAD_ID }] },
    }));
    expect(api.readThreadFamilyPricing).toHaveBeenCalledWith({
      backend: "codex", threadId: THREAD_ID, federationTarget: { scope: "remote", instanceId: "lab" },
    });
    expect(card).toHaveTextContent("lab-mini / default");
    expect(card).toHaveTextContent("Running");
    expect(card).toHaveTextContent("Default Access");
    expect(card).toHaveTextContent("$0.84");
    expect(card).toHaveTextContent("this thread");
  });

  it("says when no machine reports the thread", async () => {
    renderChip({}, []);
    const card = await openCard();

    expect(card).toHaveTextContent("not found");
    expect(card).toHaveTextContent("No connected machine reports this thread.");
    expect(card).not.toHaveTextContent("Provider");
  });

  it("does not call a thread missing when the read fails", async () => {
    api.getNavigationQueryPage.mockRejectedValueOnce(new Error("offline"));
    renderChip({}, []);
    const card = await openCard();

    expect(card).not.toHaveTextContent("not found");
    expect(card).toHaveTextContent("Provider");
  });

  it("opens no card and reads nothing when a click focuses the chip", async () => {
    renderChip({}, [summary()]);
    const chip = screen.getByRole("button", { name: /^Open thread/ });
    await act(async () => {
      fireEvent.pointerDown(chip);
      fireEvent.focus(chip);
      await Promise.resolve();
    });

    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(api.readThreadFamilyPricing).not.toHaveBeenCalled();
  });
});
