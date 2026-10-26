import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  buildThreadPricingDisplay,
  type AgentEvent,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadEntry,
  type FederationTarget,
  type NavigationSelectedDetailResponse,
  type NavigationThreadSummary,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useNavigationSelectedDetail } from "../useNavigationSelectedDetail";
import { useThreadDisplayResource } from "../useThreadDisplayResource";
import { useThreadUsageDisplay } from "../useThreadUsageDisplay";

// Every display read makes the owner rebuild the thread's whole display:
// Token Miser accounting, every sub-agent card, the overlay, and tool
// accounting. On a 2,000-turn thread each build took 50 to 130 ms, so a turn
// end's renderer refresh must cost the same number of reads on a small thread
// and a large one: one per mounted resource, not one per 256 loaded turns or
// per loaded page. These counts are a pure function of the code path.

const THREAD_ID = "thread";
const PAGE_ROWS = 20;

type ReadCounts = { accounting: number; pricing: number; detail: number };

function turnEntries(turns: number): AppServerThreadEntry[] {
  return Array.from({ length: turns }, (_, index) => ({
    type: "message", role: "assistant", id: `answer-${index}`, text: `Answer ${index}`,
    turn: { id: `turn-${index}`, status: "completed", completedAt: 1_000 + index },
  }));
}

/** An owner that serves the display caps current main enforces. */
function fakeOwner(params: { pricingRows: number }) {
  let revision = "before";
  const readThread = vi.fn(async (request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse> => {
    const display = request.display!;
    const base = {
      backend: "codex" as const, threadId: THREAD_ID, fetchedAt: 1,
      replay: { entries: [] as AppServerThreadEntry[], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    };
    if (display.resource === "accounting") {
      return { ...base, replay: { ...base.replay, entries: (display.turns ?? []).map((turn) => ({
        type: "activity", id: `usage-${turn.id}`, summary: `Turn usage: ${revision}`, status: "completed", details: [], turn,
      })) }, display: { pricing: buildThreadPricingDisplay({}), revision } };
    }
    const offset = display.cursor ? Number(display.cursor.split(":")[1]) : 0;
    const limit = display.limit ?? PAGE_ROWS;
    const end = Math.min(params.pricingRows, offset + limit);
    const rows = Array.from({ length: end - offset }, (_, index) => ({ id: `${revision}-row-${offset + index}` }));
    return { ...base, display: {
      pricing: buildThreadPricingDisplay({}), revision,
      pricingPage: { ...buildThreadPricingDisplay({}), rows, totalRows: params.pricingRows } as never,
      ...(end < params.pricingRows ? { nextCursor: `${revision}:${end}` } : {}),
    } };
  });
  const getNavigationSelectedDetail = vi.fn(async (): Promise<NavigationSelectedDetailResponse> => ({
    protocol: 2, ref: { backend: "codex", threadId: THREAD_ID }, revision: `detail-${revision}`, readiness: "ready", identity: "present",
    thread: { source: "codex", id: THREAD_ID, title: "Thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true }, threadStatus: "idle" },
    collections: [],
  }));
  return { readThread, getNavigationSelectedDetail, setRevision: (next: string) => { revision = next; } };
}

function counts(owner: ReturnType<typeof fakeOwner>): ReadCounts {
  const resources = owner.readThread.mock.calls.map(([request]) => request.display?.resource);
  return {
    accounting: resources.filter((resource) => resource === "accounting").length,
    pricing: resources.filter((resource) => resource === "pricing").length,
    detail: owner.getNavigationSelectedDetail.mock.calls.length,
  };
}

afterEach(() => vi.useRealTimers());

/** One local turn end, as main emits it: one chain of four events. */
async function measureTurnEnd(params: { loadedTurns: number; pricingRows: number; loadedPricingPages: number }): Promise<ReadCounts> {
  const owner = fakeOwner({ pricingRows: params.pricingRows });
  const listeners = new Set<(event: AgentEvent) => void>();
  const api: DesktopApi = {
    readThread: owner.readThread,
    getNavigationSelectedDetail: owner.getNavigationSelectedDetail,
    releaseNavigationQuery: async () => undefined,
    onAgentEvent: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const thread: NavigationThreadSummary = {
    source: "codex", id: THREAD_ID, title: "Thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true }, updatedAt: 1,
  };
  const entries = turnEntries(params.loadedTurns);
  const response: AppServerReadThreadResponse = {
    backend: "codex", threadId: THREAD_ID, fetchedAt: 1,
    replay: { entries, messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    display: { pricing: buildThreadPricingDisplay({}), revision: "transcript" },
  };
  const { result, unmount } = renderHook(() => ({
    usage: useThreadUsageDisplay({ desktopApi: api, thread, entries, response }),
    pricing: useThreadDisplayResource({ desktopApi: api, thread, resource: "pricing" }),
    detail: useNavigationSelectedDetail({ desktopApi: api, ref: { backend: "codex", threadId: THREAD_ID } }),
  }));
  await waitFor(() => expect(result.current.usage.filter((entry) => entry.type === "activity")).toHaveLength(params.loadedTurns));
  await waitFor(() => expect(result.current.pricing.data?.pricingPage?.rows).toHaveLength(Math.min(PAGE_ROWS, params.pricingRows)));
  await waitFor(() => expect(result.current.detail.state?.readiness).toBe("ready"));
  for (let page = 1; page < params.loadedPricingPages; page += 1) {
    await act(async () => { await result.current.pricing.loadMore(); });
  }
  const loadedRows = Math.min(params.pricingRows, params.loadedPricingPages * PAGE_ROWS);
  expect(result.current.pricing.data?.pricingPage?.rows).toHaveLength(loadedRows);

  vi.useFakeTimers();
  owner.readThread.mockClear();
  owner.getNavigationSelectedDetail.mockClear();
  owner.setRevision("after");
  const emit = (notification: AgentEvent["notification"]) => {
    for (const listener of [...listeners]) listener({ backend: "codex", notification });
  };
  act(() => {
    emit({ method: "thread/status/changed", params: { threadId: THREAD_ID, status: { type: "idle" } } } as AgentEvent["notification"]);
    emit({ method: "thread/subAgents/updated", params: { threadId: THREAD_ID } } as AgentEvent["notification"]);
    emit({ method: "thread/pricing/updated", params: { threadId: THREAD_ID, displayInvalidated: true, pricing: { lines: [], summaries: [] } } });
    emit({ method: "turn/completed", params: { threadId: THREAD_ID, turnId: `turn-${params.loadedTurns - 1}`,
      turn: { id: `turn-${params.loadedTurns - 1}`, status: "completed" } } } as AgentEvent["notification"]);
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

  // The refresh delivered the turn end's values everywhere they were shown.
  const usage = result.current.usage.filter((entry) => entry.type === "activity");
  expect(usage).toHaveLength(params.loadedTurns);
  expect(usage.every((entry) => entry.summary === "Turn usage: after")).toBe(true);
  const rows = result.current.pricing.data?.pricingPage?.rows as unknown as Array<{ id: string }>;
  expect(rows).toHaveLength(loadedRows);
  expect(rows.every((row) => row.id.startsWith("after-"))).toBe(true);
  expect(result.current.detail.state?.detail?.revision).toBe("detail-after");
  const measured = counts(owner);
  unmount();
  vi.useRealTimers();
  return measured;
}

it("refreshes a small and a large thread with one read per mounted resource at turn end", async () => {
  const small = await measureTurnEnd({ loadedTurns: 20, pricingRows: 15, loadedPricingPages: 1 });
  const large = await measureTurnEnd({ loadedTurns: 2_001, pricingRows: 2_002, loadedPricingPages: 5 });
  expect(small).toEqual({ accounting: 1, pricing: 1, detail: 1 });
  expect(large).toEqual(small);
}, 30_000);

/** Remote owners get the larger requests only when they advertise them. */
async function remoteRequestSizes(capabilities: string[]) {
  const target: FederationTarget = { scope: "remote", instanceId: "owner" };
  const owner = fakeOwner({ pricingRows: 100 });
  const api: DesktopApi = { readThread: owner.readThread };
  const thread: NavigationThreadSummary = {
    source: "codex", id: THREAD_ID, title: "Thread", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: true }, updatedAt: 1,
    federation: { ref: { backend: "codex", threadId: THREAD_ID, target }, instanceLabel: "Owner", capabilities: capabilities as never },
  };
  const entries = turnEntries(600);
  const response: AppServerReadThreadResponse = {
    backend: "codex", threadId: THREAD_ID, fetchedAt: 1,
    replay: { entries, messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    display: { pricing: buildThreadPricingDisplay({}), revision: "transcript" },
  };
  const { result, unmount } = renderHook(() => ({
    usage: useThreadUsageDisplay({ desktopApi: api, thread, entries, response }),
    pricing: useThreadDisplayResource({ desktopApi: api, thread, resource: "pricing" }),
  }));
  await waitFor(() => expect(result.current.usage.filter((entry) => entry.type === "activity")).toHaveLength(600));
  await waitFor(() => expect(result.current.pricing.data?.pricingPage?.rows).toHaveLength(PAGE_ROWS));
  const accountingTurns = owner.readThread.mock.calls
    .flatMap(([request]) => request.display?.resource === "accounting" ? [request.display.turns?.length] : []);
  for (let page = 1; page < 3; page += 1) {
    await act(async () => { await result.current.pricing.loadMore(); });
  }
  owner.readThread.mockClear();
  owner.setRevision("after");
  await act(async () => { await result.current.pricing.refresh(); });
  const rows = result.current.pricing.data?.pricingPage?.rows as unknown as Array<{ id: string }>;
  expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 60 }, (_, index) => `after-row-${index}`));
  const pricingLimits = owner.readThread.mock.calls.map(([request]) => request.display?.limit);
  unmount();
  return { accountingTurns, pricingLimits };
}

it("keeps 256-turn chunks and 20-row pages for an owner without bulk display reads", async () => {
  expect(await remoteRequestSizes(["thread_detail", "event_subscriptions"]))
    .toEqual({ accountingTurns: [256, 256, 88], pricingLimits: [20, 20, 20] });
});

it("reads all loaded turns and rows at once from an owner that advertises bulk display reads", async () => {
  expect(await remoteRequestSizes(["thread_detail", "event_subscriptions", "thread_display_bulk_reads"]))
    .toEqual({ accountingTurns: [600], pricingLimits: [60] });
});
