import "@testing-library/jest-dom/vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerToolRequestUserInputNotification,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadMessage,
  AppServerThreadMessageEntry,
  AppServerThreadReviewEntry,
  NavigationThreadSummary,
  ThreadUsageLineRecord,
} from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getContextWindowMoonPhase,
  useThreadSessionState,
} from "../useThreadSessionState";
import {
  DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
  THREAD_HISTORY_PAGE_LIMIT,
} from "../thread-history-limits";
import { readRendererSequence } from "../../features/thread-detail/live-transcript-activity";

function buildThread(params: {
  codexEnvironmentRuntime?: NavigationThreadSummary["codexEnvironmentRuntime"];
  id: string;
  updatedAt: number;
}): NavigationThreadSummary {
  return {
    id: params.id,
    title: `Thread ${params.id}`,
    titleSource: "explicit" as const,
    summary: `Summary for ${params.id}`,
    source: "codex" as const,
    linkedDirectories: [],
    inbox: {
      inInbox: false,
    },
    codexEnvironmentRuntime: params.codexEnvironmentRuntime,
    updatedAt: params.updatedAt,
  };
}

function transcriptLabels(entries: AppServerThreadEntry[]): string[] {
  return entries.map((entry) =>
    entry.type === "message" && "text" in entry
      ? `message:${entry.text}`
      : entry.type === "activity" && "summary" in entry
        ? `activity:${entry.summary}`
        : entry.type
  );
}

function authoritativeTurnUsageLine(): ThreadUsageLineRecord {
  return {
    backend: "codex",
    cachedInputCostMicros: 9_818_317,
    cachedInputTokens: 24_545_792,
    completedAt: 4_000,
    createdAt: 1_000,
    currency: "USD",
    inputTokens: 25_139_426,
    model: "gpt-5.6-sol",
    outputCostMicros: 1_812_620,
    outputTokens: 66_567,
    priceStatus: "priced",
    provider: "openai",
    reasoningOutputTokens: 24_064,
    scope: "turn",
    serviceTier: "standard",
    source: "live",
    status: "pending",
    threadId: "thread-1",
    totalCostMicros: 14_005_473,
    totalTokens: 25_205_993,
    turnId: "turn-1",
    turnUsageAttributed: true,
    uncachedInputCostMicros: 2_374_536,
    uncachedInputTokens: 593_634,
    usageLineId: "codex:thread-1:turn-1:live-token-usage",
  };
}

function messageEntry(params: {
  createdAt: number;
  id: string;
  role?: AppServerThreadMessage["role"];
  text: string;
}): AppServerThreadMessageEntry {
  return {
    type: "message",
    id: params.id,
    role: params.role ?? "assistant",
    text: params.text,
    createdAt: params.createdAt,
  };
}

function reviewEntry(params: {
  createdAt: number;
  id: string;
  review: string;
  turnId?: string;
}): AppServerThreadReviewEntry {
  return {
    type: "review",
    id: params.id,
    review: params.review,
    createdAt: params.createdAt,
    ...(params.turnId
      ? {
          turn: {
            id: params.turnId,
            status: "completed",
          },
        }
      : {}),
  };
}

function readThreadResponse(params: {
  entries: AppServerThreadEntry[];
  fetchedAt?: number;
  hasPreviousPage: boolean;
  previousCursor?: string;
  readDurationMs?: number;
  supportsPagination?: boolean;
  threadId?: string;
  threadStatus?: AppServerReadThreadResponse["threadStatus"];
}): AppServerReadThreadResponse {
  return {
    backend: "codex",
    fetchedAt: params.fetchedAt ?? Date.now(),
    readDurationMs: params.readDurationMs,
    threadId: params.threadId ?? "thread-1",
    threadStatus: params.threadStatus ?? "idle",
    replay: {
      entries: params.entries,
      messages: params.entries
        .filter(
          (entry): entry is AppServerThreadMessageEntry =>
            entry.type === "message"
        )
        .map(({ type: _type, ...message }) => message),
      pagination: {
        supportsPagination: params.supportsPagination ?? true,
        hasPreviousPage: params.hasPreviousPage,
        ...(params.previousCursor
          ? { previousCursor: params.previousCursor }
          : {}),
      },
    },
  };
}

function diffActivity(params: {
  diff: string;
  id: string;
  summary: string;
  turn: AppServerThreadActivityEntry["turn"];
}): AppServerThreadActivityEntry {
  return {
    type: "activity",
    id: params.id,
    summary: params.summary,
    createdAt: Date.now(),
    details: [
      {
        id: `${params.id}-detail`,
        kind: "write",
        label: "Update current.ts",
        fileDiff: {
          kind: "update",
          diff: params.diff,
          additions: 1,
          removals: 1,
        },
      },
    ],
    turn: params.turn,
  };
}

async function waitForThreadHydration(
  result: { current: { response?: AppServerReadThreadResponse } },
  threadId = "thread-1"
): Promise<void> {
  await waitFor(() => {
    expect(result.current.response?.threadId).toBe(threadId);
  });
}

async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("useThreadSessionState", () => {
  afterEach(async () => {
    await flushReactUpdates();
    vi.restoreAllMocks();
  });

  it("maps context window moon phases to explicit fill thresholds", () => {
    expect(getContextWindowMoonPhase(0)).toBe(0);
    expect(getContextWindowMoonPhase(9.99)).toBe(0);
    expect(getContextWindowMoonPhase(10)).toBe(1);
    expect(getContextWindowMoonPhase(22.49)).toBe(1);
    expect(getContextWindowMoonPhase(22.5)).toBe(2);
    expect(getContextWindowMoonPhase(34.99)).toBe(2);
    expect(getContextWindowMoonPhase(35)).toBe(3);
    expect(getContextWindowMoonPhase(47.49)).toBe(3);
    expect(getContextWindowMoonPhase(47.5)).toBe(4);
    expect(getContextWindowMoonPhase(59.99)).toBe(4);
    expect(getContextWindowMoonPhase(60)).toBe(5);
    expect(getContextWindowMoonPhase(72.49)).toBe(5);
    expect(getContextWindowMoonPhase(72.5)).toBe(6);
    expect(getContextWindowMoonPhase(84.99)).toBe(6);
    expect(getContextWindowMoonPhase(85)).toBe(7);
    expect(getContextWindowMoonPhase(97.49)).toBe(7);
    expect(getContextWindowMoonPhase(97.5)).toBe(8);
    expect(getContextWindowMoonPhase(100)).toBe(8);
    expect(getContextWindowMoonPhase(100.01)).toBe(8);
  });

  it("keeps the first successful thread-read duration across later hydrations", async () => {
    let readCount = 0;
    const readThread = vi.fn(async () => {
      readCount += 1;
      return readThreadResponse({
        entries: [],
        fetchedAt: readCount,
        hasPreviousPage: false,
        readDurationMs: readCount === 1 ? 725 : 12,
      });
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }) =>
        useThreadSessionState({
          desktopApi,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitFor(() => {
      expect(result.current.initialLoadDurationMs).toBe(725);
    });

    rerender({ updatedAt: 2_000 });
    await waitFor(() => {
      expect(result.current.response?.fetchedAt).toBe(2);
    });
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(result.current.initialLoadDurationMs).toBe(725);
  });

  it("exposes selected thread busy state from the same thinking state as row indicators", () => {
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "idle" as const,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    expect(result.current.threadBusy).toBe(false);

    act(() => {
      result.current.setPendingStatusText("Thinking");
    });

    expect(result.current.threadBusy).toBe(true);
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    act(() => {
      result.current.setPendingStatusText(undefined);
    });

    expect(result.current.threadBusy).toBe(false);
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
  });

  it("uses a bounded initial thread history limit when configured", async () => {
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      threadStatus: "idle" as const,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: true,
          hasPreviousPage: true,
          previousCursor: "entry-1",
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    expect(readThread).toHaveBeenCalledWith({
      backend: "codex",
      limit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
      threadId: "thread-1",
    });
  });

  it("preserves loaded older transcript pages across limited refreshes", async () => {
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({ id: "recent-1", text: "Recent 1", createdAt: 300 }),
        messageEntry({ id: "recent-2", text: "Recent 2", createdAt: 400 }),
      ],
      hasPreviousPage: true,
      previousCursor: "older-page",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({ id: "older-1", text: "Older 1", createdAt: 100 }),
        messageEntry({ id: "older-2", text: "Older 2", createdAt: 200 }),
      ],
      hasPreviousPage: true,
      previousCursor: "oldest-page",
    });
    const refreshedTail = readThreadResponse({
      entries: [
        messageEntry({ id: "recent-1", text: "Recent 1", createdAt: 300 }),
        messageEntry({ id: "recent-2", text: "Recent 2", createdAt: 400 }),
        messageEntry({ id: "recent-3", text: "Recent 3", createdAt: 500 }),
      ],
      hasPreviousPage: true,
      previousCursor: "older-page-again",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      {
        initialProps: { updatedAt: 1_000 },
      }
    );

    await waitForThreadHydration(result);
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Recent 1",
      "message:Recent 2",
    ]);

    await act(async () => {
      await result.current.loadOlder();
    });

    expect(readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      before: "older-page",
      limit: THREAD_HISTORY_PAGE_LIMIT,
      threadId: "thread-1",
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Older 1",
        "message:Older 2",
        "message:Recent 1",
        "message:Recent 2",
      ]);
    });
    expect(result.current.response?.replay.pagination.previousCursor).toBe(
      "oldest-page"
    );

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });

    expect(readThread).toHaveBeenLastCalledWith({
      backend: "codex",
      limit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
      threadId: "thread-1",
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Older 1",
        "message:Older 2",
        "message:Recent 1",
        "message:Recent 2",
        "message:Recent 3",
      ]);
    });
    expect(result.current.response?.replay.pagination.previousCursor).toBe(
      "oldest-page"
    );
  });

  it("keeps completed remote turns ordered when a bounded refresh advances past them", async () => {
    const publishedTurn = {
      id: "published-turn",
      status: "completed" as const,
      startedAt: 200,
      completedAt: 500,
    };
    const repairTurn = {
      id: "repair-turn",
      status: "completed" as const,
      startedAt: 600,
      completedAt: 900,
    };
    const ciTurn = {
      id: "ci-turn",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 1_100,
    };
    const repairUsage: AppServerThreadActivityEntry = {
      type: "activity",
      id: "repair-usage",
      summary: "Turn usage: repair",
      createdAt: 901,
      details: [],
      turn: repairTurn,
    };
    const initialTail = readThreadResponse({
      entries: [
        {
          type: "activity",
          id: "published-diff",
          summary: "Edited 2 files",
          createdAt: 300,
          details: [],
          turn: publishedTurn,
        },
        {
          ...messageEntry({
            id: "published-final",
            text: "Draft PR created",
            createdAt: 500,
          }),
          phase: "final" as const,
          turn: publishedTurn,
        },
        {
          type: "review",
          id: "review-start",
          review: "changes against origin/main",
          displayText: "Review changes against origin/main",
          turn: {
            id: "review-turn",
            status: "completed" as const,
            startedAt: 550,
            completedAt: 590,
          },
        },
        {
          type: "review",
          id: "review-result",
          review: "The release workflow is blocked.",
          createdAt: 590,
          turn: {
            id: "review-turn",
            status: "completed" as const,
            startedAt: 550,
            completedAt: 590,
          },
        },
        repairUsage,
      ],
      hasPreviousPage: true,
      previousCursor: "published-diff",
    });
    const olderPage = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "older-history",
            text: "Older history",
            createdAt: 100,
          }),
          turn: {
            id: "older-turn",
            status: "completed" as const,
          },
        },
      ],
      hasPreviousPage: false,
    });
    const refreshedTail = readThreadResponse({
      entries: [
        repairUsage,
        {
          ...messageEntry({
            id: "ci-notification",
            role: "user",
            text: "CI failed",
            createdAt: 1_000,
          }),
          turn: ciTurn,
        },
        {
          ...messageEntry({
            id: "ci-final",
            text: "Auto-fix is already active",
            createdAt: 1_100,
          }),
          phase: "final" as const,
          turn: ciTurn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "repair-usage",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const remoteThread = (updatedAt: number): NavigationThreadSummary => ({
      ...buildThread({ id: "thread-1", updatedAt }),
      federation: {
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "owner-m5",
          },
          threadId: "thread-1",
        },
        instanceLabel: "Remote M5",
        capabilities: ["thread_detail"],
      },
    });
    const { result, rerender } = renderHook(
      ({ selectedThread }: { selectedThread?: NavigationThreadSummary }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: selectedThread,
        }),
      {
        initialProps: {
          selectedThread: remoteThread(1_000) as NavigationThreadSummary | undefined,
        },
      },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    // Reproduce leaving the mounted thread and selecting it again after the
    // owner advances. The retained session survives this temporary unmount.
    rerender({ selectedThread: undefined });
    rerender({ selectedThread: remoteThread(2_000) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual([
        "older-history",
        "published-diff",
        "published-final",
        "review-start",
        "review-result",
        "repair-usage",
        "ci-notification",
        "ci-final",
      ]);
    });
    expect(result.current.response?.replay.messages.map((message) => message.id)).toEqual([
      "older-history",
      "published-final",
      "ci-notification",
      "ci-final",
    ]);
    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({
      federationTarget: {
        scope: "remote",
        instanceId: "owner-m5",
      },
      limit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
      threadId: "thread-1",
    }));
  });

  it("keeps an omitted completed turn before a disjoint newer tail", async () => {
    const initialTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "completed-old-turn",
            text: "Completed old turn",
            createdAt: 200,
          }),
          turn: {
            id: "old-turn",
            status: "completed" as const,
            completedAt: 200,
          },
        },
      ],
      hasPreviousPage: true,
      previousCursor: "completed-old-turn",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-history",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const refreshedTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "new-turn",
            text: "New turn",
            createdAt: 300,
          }),
          turn: {
            id: "new-turn",
            status: "completed" as const,
            completedAt: 300,
          },
        },
      ],
      hasPreviousPage: true,
      previousCursor: "new-turn",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual([
        "older-history",
        "completed-old-turn",
        "new-turn",
      ]);
    });
  });

  it("keeps an omitted completed turn between refreshed anchors", async () => {
    const completedMessage = (
      id: string,
      text: string,
      createdAt: number,
    ): AppServerThreadMessageEntry => ({
      ...messageEntry({ id, text, createdAt }),
      turn: {
        id: `${id}-turn`,
        status: "completed" as const,
        completedAt: createdAt,
      },
    });
    const firstAnchor = completedMessage("first-anchor", "First anchor", 200);
    const lastAnchor = completedMessage("last-anchor", "Last anchor", 400);
    const initialTail = readThreadResponse({
      entries: [
        firstAnchor,
        completedMessage("omitted-middle", "Omitted middle", 300),
        lastAnchor,
      ],
      hasPreviousPage: true,
      previousCursor: "first-anchor",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-history",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const refreshedTail = readThreadResponse({
      entries: [
        firstAnchor,
        lastAnchor,
        completedMessage("new-tail", "New tail", 500),
      ],
      hasPreviousPage: true,
      previousCursor: "first-anchor",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual([
        "older-history",
        "first-anchor",
        "omitted-middle",
        "last-anchor",
        "new-tail",
      ]);
    });
  });

  it("retains a genuinely newer completed turn after a lagging refresh", async () => {
    const anchor = {
      ...messageEntry({
        id: "refresh-anchor",
        text: "Refresh anchor",
        createdAt: 200,
      }),
      turn: {
        id: "anchor-turn",
        status: "completed" as const,
        completedAt: 200,
      },
    };
    const initialTail = readThreadResponse({
      entries: [
        anchor,
        {
          ...messageEntry({
            id: "newer-live-turn",
            text: "Newer live turn",
            createdAt: 300,
          }),
          turn: {
            id: "newer-turn",
            status: "completed" as const,
            completedAt: 300,
          },
        },
      ],
      hasPreviousPage: true,
      previousCursor: "refresh-anchor",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-history",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const staleTail = readThreadResponse({
      entries: [anchor],
      hasPreviousPage: true,
      previousCursor: "refresh-anchor",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(staleTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual([
        "older-history",
        "refresh-anchor",
        "newer-live-turn",
      ]);
    });
  });

  it("stitches many older pages without weakening exact-id overlap rules", async () => {
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({
            id: "tail",
            text: "Authoritative tail",
            createdAt: 500,
          }),
        ],
        hasPreviousPage: true,
        previousCursor: "page-1",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "page-1", text: "Repeated", createdAt: 400 }),
          messageEntry({ id: "tail", text: "Stale tail", createdAt: 500 }),
        ],
        hasPreviousPage: true,
        previousCursor: "page-2",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "page-2", text: "Repeated", createdAt: 300 }),
          messageEntry({ id: "page-1", text: "Stale page 1", createdAt: 400 }),
        ],
        hasPreviousPage: true,
        previousCursor: "page-3",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "page-3", text: "Oldest", createdAt: 200 }),
        ],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
      await act(async () => {
        await result.current.loadOlder();
      });
    }

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "page-3",
      "page-2",
      "page-1",
      "tail",
    ]);
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Oldest",
      "message:Repeated",
      "message:Repeated",
      "message:Authoritative tail",
    ]);
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "page-3",
      "page-2",
      "page-1",
      "tail",
    ]);
    expect(result.current.response?.replay.pagination.hasPreviousPage).toBe(false);
  });

  it("keeps hook-level paging linear and live appends independent of retained history", async () => {
    const pageCount = 100;
    const entriesPerPage = 50;
    let retainedEntryClassificationReads = 0;
    const retainedEntry = (
      id: string,
      createdAt: number,
    ): AppServerThreadEntry =>
      new Proxy(
        messageEntry({ id, text: id, createdAt }),
        {
          get(target, property, receiver) {
            if (property === "type") {
              retainedEntryClassificationReads += 1;
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
    const responses = [
      readThreadResponse({
        entries: [messageEntry({ id: "tail", text: "Tail", createdAt: 10_000 })],
        hasPreviousPage: true,
        previousCursor: "page-0",
      }),
      ...Array.from({ length: pageCount }, (_value, pageIndex) =>
        readThreadResponse({
          entries: Array.from({ length: entriesPerPage }, (_entry, entryIndex) =>
            retainedEntry(
              `history-${pageIndex}-${entryIndex}`,
              5_000 - pageIndex * entriesPerPage - entryIndex,
            )
          ),
          hasPreviousPage: pageIndex + 1 < pageCount,
          ...(pageIndex + 1 < pageCount
            ? { previousCursor: `page-${pageIndex + 1}` }
            : {}),
        })
      ),
    ];
    retainedEntryClassificationReads = 0;
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async () => responses.shift()!),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
      await act(async () => {
        await result.current.loadOlder();
      });
    }

    const pagingClassificationReads = retainedEntryClassificationReads;
    expect(result.current.entries.map((entry) => entry.id)).toHaveLength(5_001);
    retainedEntryClassificationReads = 0;

    for (let liveIndex = 0; liveIndex < 100; liveIndex += 1) {
      act(() => {
        result.current.upsertLiveTranscriptEntry(messageEntry({
          id: `live-${liveIndex}`,
          text: `Live ${liveIndex}`,
          createdAt: 20_000 + liveIndex,
        }));
      });
      expect(result.current.entries.slice(-1)[0]?.id).toBe(`live-${liveIndex}`);
    }

    const loadedEntries = pageCount * entriesPerPage;
    const legacyTriangularHistorySlots =
      entriesPerPage * pageCount * (pageCount + 1) / 2;
    // The same generated hook harness measured these exact formulas at
    // pre-#1625 9eb1ce533 and #1625 d418e6335, respectively.
    const pre1625HookPagingClassificationReads =
      5 * legacyTriangularHistorySlots;
    const pre1625HookLiveClassificationReads = 4 * loadedEntries * 100;
    const pr1625HookPagingClassificationReads =
      loadedEntries + 3 * legacyTriangularHistorySlots;
    const pr1625HookLiveClassificationReads = 3 * loadedEntries * 100;
    expect({
      legacyTriangularHistorySlots,
      liveAppendClassificationReads: retainedEntryClassificationReads,
      loadedEntries,
      pagingClassificationReads,
      pre1625HookLiveClassificationReads,
      pre1625HookPagingClassificationReads,
      pr1625HookLiveClassificationReads,
      pr1625HookPagingClassificationReads,
    }).toEqual({
      legacyTriangularHistorySlots: 252_500,
      liveAppendClassificationReads: 0,
      loadedEntries: 5_000,
      // One classification builds replay messages and one builds the compact
      // review summary. Neither revisits a page after it has been retained.
      pagingClassificationReads: 10_000,
      pre1625HookLiveClassificationReads: 2_000_000,
      pre1625HookPagingClassificationReads: 1_262_500,
      pr1625HookLiveClassificationReads: 1_500_000,
      pr1625HookPagingClassificationReads: 762_500,
    });
  });

  it("keeps latest-page refresh work linear in retained tail entries", async () => {
    const tailEntryCount = 100;
    const turn = {
      id: "large-live-turn",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 2_000,
    };
    let retainedTailIdReads = 0;
    const retainedTail = Array.from(
      { length: tailEntryCount },
      (_value, index): AppServerThreadEntry =>
        new Proxy(
          {
            ...messageEntry({
              id: `tail-${index}`,
              text: `Tail ${index}`,
              createdAt: 1_000 + index,
            }),
            turn,
          },
          {
            get(target, property, receiver) {
              if (property === "id") {
                retainedTailIdReads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    );
    const refreshedTail = [
      ...Array.from({ length: tailEntryCount - 1 }, (_value, index) => ({
        ...messageEntry({
          id: `tail-${index + 1}`,
          text: `Tail ${index + 1}`,
          createdAt: 1_001 + index,
        }),
        turn,
      })),
      {
        ...messageEntry({
          id: "tail-new",
          text: "Newest tail entry",
          createdAt: 2_000,
        }),
        turn,
      },
    ];
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: retainedTail,
        hasPreviousPage: true,
        previousCursor: "older",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [messageEntry({
          id: "older-history",
          text: "Older history",
          createdAt: 500,
        })],
        hasPreviousPage: false,
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: refreshedTail,
        hasPreviousPage: true,
        previousCursor: "tail-1",
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    retainedTailIdReads = 0;
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.response?.replay.entries.at(-1)?.id).toBe("tail-new");
    });
    // Before the indexed refresh match, this harness read retained IDs 20,607
    // times. Keep enough slack for React's async observation without allowing
    // the prior tail² scan back into the append path.
    expect(retainedTailIdReads).toBeLessThanOrEqual(tailEntryCount * 8);
  });

  it("keeps changed-id refresh matching linear in retained tail entries", async () => {
    const tailEntryCount = 50;
    const turn = {
      id: "changed-id-turn",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 2_000,
    };
    let retainedTailIdReads = 0;
    const retainedTail = Array.from(
      { length: tailEntryCount },
      (_value, index): AppServerThreadEntry =>
        new Proxy(
          {
            ...messageEntry({
              id: `retained-${index}`,
              text: `Unique message ${index}`,
              createdAt: 1_000 + index,
            }),
            turn,
          },
          {
            get(target, property, receiver) {
              if (property === "id") {
                retainedTailIdReads += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        ),
    );
    const refreshedTail = Array.from(
      { length: tailEntryCount },
      (_value, index): AppServerThreadEntry => ({
        ...messageEntry({
          id: `fresh-${index}`,
          text: `Unique message ${index}`,
          createdAt: 1_000 + index,
        }),
        turn,
      }),
    );
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: retainedTail,
        hasPreviousPage: true,
        previousCursor: "older",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [messageEntry({
          id: "older-history",
          text: "Older history",
          createdAt: 500,
        })],
        hasPreviousPage: false,
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: refreshedTail,
        hasPreviousPage: true,
        previousCursor: "fresh-0",
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    retainedTailIdReads = 0;
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(result.current.response?.replay.entries.map((entry) => entry.id)).toEqual([
        "older-history",
        ...Array.from({ length: tailEntryCount }, (_value, index) => `fresh-${index}`),
      ]);
    });
    // The full-tail fallback read 6,425 retained IDs here. Unique logical
    // buckets reduce that to 350 while leaving room for async observation.
    expect(retainedTailIdReads).toBeLessThanOrEqual(tailEntryCount * 12);
  });

  it("keeps batched live optimistic appends linear in prior tail entries", async () => {
    const liveEntryCount = 100;
    let liveEntryIdReads = 0;
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async () => readThreadResponse({
        entries: [],
        hasPreviousPage: false,
        supportsPagination: false,
      })),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    act(() => {
      for (let index = 0; index < liveEntryCount; index += 1) {
        result.current.upsertLiveTranscriptEntry(
          new Proxy(
            messageEntry({
              id: `live-${index}`,
              text: `Live ${index}`,
              createdAt: 2_000 + index,
            }),
            {
              get(target, property, receiver) {
                if (property === "id") {
                  liveEntryIdReads += 1;
                }
                return Reflect.get(target, property, receiver);
              },
            },
          ),
        );
      }
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual(
      Array.from({ length: liveEntryCount }, (_value, index) => `live-${index}`),
    );
    // Array upsert plus transcript/message merge read 25,650 IDs here. The
    // indexed store and ordered-append paths reduce that to 800.
    expect(liveEntryIdReads).toBeLessThanOrEqual(liveEntryCount * 12);
  });

  it("does not rescan split-hydrated launch messages for every live update", async () => {
    const historyMessageCount = 48;
    const liveUpdateCount = 12;
    const launchpadText = "Keep this prompt visible while the turn starts.";

    async function measureMessageTextReads(
      includeLaunchpadState: boolean,
    ): Promise<number> {
      let messageTextReads = 0;
      const messageEntries: AppServerThreadMessageEntry[] = Array.from(
        { length: historyMessageCount },
        (_value, index) => ({
          ...messageEntry({
            id: `history-${index}`,
            role: "user",
            text: `Historical prompt ${index}`,
            createdAt: index,
          }),
          turn: {
            id: `history-turn-${index}`,
            status: "completed" as const,
          },
        }),
      );
      const entries: AppServerThreadEntry[] = messageEntries;
      const hydratedLaunchMessage: AppServerThreadMessage = {
        id: "hydrated-launch",
        role: "user",
        text: launchpadText,
        createdAt: 1_000,
      };
      const messages: AppServerThreadMessage[] = [
        ...messageEntries.map(
          ({ type: _type, turn: _turn, ...message }) => message,
        ),
        hydratedLaunchMessage,
      ].map((message) => new Proxy(message, {
        get(target, property, receiver) {
          if (property === "text") {
            messageTextReads += 1;
          }
          return Reflect.get(target, property, receiver);
        },
      }));
      const desktopApi: DesktopApi = {
        onAgentEvent: () => () => undefined,
        readThread: async ({ backend, threadId }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries,
            messages,
            pagination: {
              supportsPagination: true,
              hasPreviousPage: false,
            },
          },
        }),
      };
      const { result, rerender, unmount } = renderHook(
        ({ showLaunchpadState }) =>
          useThreadSessionState({
            desktopApi,
            thread: {
              ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
              ...(showLaunchpadState
                ? {
                    optimisticUserMessage: {
                      text: launchpadText,
                      createdAt: 1_000,
                    },
                    optimisticActiveTurn: {
                      id: "turn-1",
                      statusText: "Thinking",
                      startedAt: 1_000,
                    },
                  }
                : {}),
            },
          }),
        { initialProps: { showLaunchpadState: includeLaunchpadState } },
      );

      await waitForThreadHydration(result);
      rerender({ showLaunchpadState: false });
      await waitFor(() => {
        expect(result.current.messages.at(-1)?.id).toBe("hydrated-launch");
      });
      messageTextReads = 0;

      for (let index = 0; index < liveUpdateCount; index += 1) {
        act(() => {
          result.current.upsertLiveTranscriptEntry({
            type: "activity",
            id: `live-activity-${index}`,
            summary: `Live activity ${index}`,
            createdAt: 2_000 + index,
            details: [],
            turn: {
              id: "turn-1",
              status: "in_progress",
              startedAt: 1_000,
            },
          });
        });
      }

      const measuredReads = messageTextReads;
      unmount();
      return measuredReads;
    }

    const baselineReads = await measureMessageTextReads(false);
    const launchpadReads = await measureMessageTextReads(true);

    // Launch-message correlation may inspect the hydrated projection once,
    // but live tail updates must not multiply that full-transcript scan.
    expect(launchpadReads - baselineReads).toBeLessThanOrEqual(
      (historyMessageCount + 1) * 2,
    );
  });

  it("coalesces reviews and suppresses duplicates across page-tail boundaries", async () => {
    const fullReview = [
      "Full review comments:",
      "- [P1] Keep exact ID ordering — src/thread.ts:42",
    ].join("\n");
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({
            id: "review-assistant",
            text: fullReview,
            createdAt: 500,
          }),
          messageEntry({
            id: "duplicate-assistant",
            text: "Duplicate review summary",
            createdAt: 600,
          }),
          messageEntry({ id: "repeat-a", text: "Repeated", createdAt: 700 }),
          messageEntry({ id: "repeat-b", text: "Repeated", createdAt: 800 }),
        ],
        hasPreviousPage: true,
        previousCursor: "older",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          reviewEntry({
            id: "review-base",
            review: "Full review comments:",
            createdAt: 100,
          }),
          reviewEntry({
            id: "review-duplicate",
            review: "Duplicate review summary",
            createdAt: 200,
          }),
        ],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "review-base",
      "review-duplicate",
      "repeat-a",
      "repeat-b",
    ]);
    expect(result.current.entries[0]).toMatchObject({
      type: "review",
      review: fullReview,
    });
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "repeat-a",
      "repeat-b",
    ]);
    expect(result.current.messages.map((message) => message.text)).toEqual([
      "Repeated",
      "Repeated",
    ]);
  });

  it("uses a live tail review to suppress a matching retained assistant message", async () => {
    const duplicateText = "Review result delivered from the live tail";
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "recent-anchor", text: "Recent", createdAt: 300 }),
        ],
        hasPreviousPage: true,
        previousCursor: "older",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "retained-duplicate", text: duplicateText, createdAt: 100 }),
        ],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "retained-duplicate",
      "recent-anchor",
    ]);

    act(() => {
      result.current.upsertLiveTranscriptEntry(
        reviewEntry({
          id: "live-review",
          review: duplicateText,
          createdAt: 500,
        }),
      );
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "recent-anchor",
      "live-review",
    ]);
    expect(result.current.messages.map((message) => message.id)).toEqual([
      "recent-anchor",
    ]);
  });

  it("drops retained review indexes when compaction resets loaded history", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const duplicateText = "Historical review summary";
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          messageEntry({ id: "before-compact", text: duplicateText, createdAt: 300 }),
        ],
        hasPreviousPage: true,
        previousCursor: "older",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          reviewEntry({ id: "historical-review", review: duplicateText, createdAt: 100 }),
        ],
        hasPreviousPage: false,
      }))
      .mockResolvedValue(readThreadResponse({
        entries: [
          messageEntry({ id: "after-compact", text: duplicateText, createdAt: 500 }),
        ],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventHandler = listener;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "historical-review",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/compacted",
          params: { threadId: "thread-1" },
        },
      });
    });
    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "after-compact",
      ]);
    });
  });

  it("keeps cross-page review coalescing ordered across lagging hydration", async () => {
    let resolveRefresh:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    const fullReview = [
      "Full review comments:",
      "- [P2] Preserve the loaded prefix — src/history.ts:9",
    ].join("\n");
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({ id: "recent-anchor", text: "Recent", createdAt: 300 }),
      ],
      hasPreviousPage: true,
      previousCursor: "older",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({ id: "oldest-anchor", text: "Oldest", createdAt: 50 }),
        reviewEntry({
          id: "historical-review",
          review: "Full review comments:",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const refreshPromise = new Promise<AppServerReadThreadResponse>((resolve) => {
      resolveRefresh = resolve;
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockImplementation(async () => await refreshPromise);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    rerender({ updatedAt: 2_000 });
    await waitFor(() => {
      expect(resolveRefresh).toBeDefined();
    });

    act(() => {
      result.current.upsertLiveTranscriptEntry(messageEntry({
        id: "live-review-output",
        text: fullReview,
        createdAt: 500,
      }));
    });
    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "oldest-anchor",
      "historical-review",
      "recent-anchor",
    ]);
    expect(result.current.entries[1]).toMatchObject({ review: fullReview });

    await act(async () => {
      resolveRefresh?.(readThreadResponse({
        entries: [
          messageEntry({ id: "recent-anchor", text: "Recent", createdAt: 300 }),
        ],
        hasPreviousPage: true,
        previousCursor: "older-again",
      }));
      await Promise.resolve();
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "oldest-anchor",
      "historical-review",
      "recent-anchor",
    ]);
    expect(result.current.entries[1]).toMatchObject({ review: fullReview });
  });

  it("replaces an overlapping live tail when hydrated message ids change", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const activeTurn = {
      id: "turn-current",
      status: "in_progress" as const,
      startedAt: 1_000,
    };
    const completedTurn = {
      ...activeTurn,
      status: "completed" as const,
      completedAt: 2_000,
    };
    const initialTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "stable-tail-anchor",
            role: "user",
            text: "Earlier prompt",
            createdAt: 500,
          }),
          turn: { id: "turn-earlier", status: "completed" },
        },
        {
          ...messageEntry({
            id: "current-user",
            role: "user",
            text: "Audit the backports",
            createdAt: 1_000,
          }),
          turn: activeTurn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "stable-tail-anchor",
      threadStatus: "active",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-message",
          role: "user",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const refreshedTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "stable-tail-anchor",
            role: "user",
            text: "Earlier prompt",
            createdAt: 500,
          }),
          turn: { id: "turn-earlier", status: "completed" },
        },
        {
          ...messageEntry({
            id: "current-user",
            role: "user",
            text: "Audit the backports",
            createdAt: 1_000,
          }),
          turn: completedTurn,
        },
        {
          ...messageEntry({
            id: "item-57",
            text: "First commentary.",
            createdAt: 1_100,
          }),
          phase: "commentary" as const,
          turn: completedTurn,
        },
        {
          ...messageEntry({
            id: "item-58",
            text: "Second commentary.",
            createdAt: 1_300,
          }),
          phase: "commentary" as const,
          turn: completedTurn,
        },
        {
          ...messageEntry({
            id: "item-61",
            text: "Final answer.",
            createdAt: 2_000,
          }),
          phase: "final" as const,
          turn: completedTurn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "stable-tail-anchor",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: activeTurn,
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            itemId: "live-commentary-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "rg -n backport src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            itemId: "live-commentary-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            item: {
              id: "live-commentary-2",
              type: "agentMessage",
              phase: "commentary",
              text: "Second commentary.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            item: {
              id: "live-final",
              type: "agentMessage",
              phase: "final_answer",
              text: "Final answer.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: activeTurn.id,
            turn: {
              ...completedTurn,
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Older history",
      "message:Earlier prompt",
      "message:Audit the backports",
      "message:First commentary.",
      "activity:Searched src",
      "message:Second commentary.",
      "message:Final answer.",
    ]);

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Older history",
        "message:Earlier prompt",
        "message:Audit the backports",
        "message:First commentary.",
        "activity:Searched src",
        "message:Second commentary.",
        "message:Final answer.",
      ]);
    });

  });

  it("preserves completed live entries omitted by a stale tail refresh", async () => {
    const turn = {
      id: "completed-live-turn",
      status: "completed" as const,
      startedAt: 200,
      completedAt: 400,
    };
    const anchor = {
      ...messageEntry({
        id: "tail-anchor",
        role: "user" as const,
        text: "Prompt",
        createdAt: 200,
      }),
      turn,
    };
    const initialTail = readThreadResponse({
      entries: [
        anchor,
        {
          ...messageEntry({
            id: "live-commentary",
            text: "Completed commentary",
            createdAt: 300,
          }),
          phase: "commentary" as const,
          turn,
        },
        {
          ...messageEntry({
            id: "live-final",
            text: "Completed final",
            createdAt: 400,
          }),
          phase: "final" as const,
          turn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "tail-anchor",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-message",
          role: "user",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const staleTail = readThreadResponse({
      entries: [anchor],
      hasPreviousPage: true,
      previousCursor: "tail-anchor",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(staleTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Older history",
        "message:Prompt",
        "message:Completed commentary",
        "message:Completed final",
      ]);
    });
  });

  it("preserves a loaded prefix when the latest page starts mid-turn", async () => {
    const turn = {
      id: "split-turn",
      status: "completed" as const,
      startedAt: 100,
      completedAt: 400,
    };
    const initialTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "middle-live-id",
            text: "Middle of the turn",
            createdAt: 200,
          }),
          phase: "commentary" as const,
          turn,
        },
        {
          ...messageEntry({
            id: "turn-final",
            text: "Turn final",
            createdAt: 400,
          }),
          phase: "final" as const,
          turn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "middle-live-id",
    });
    const olderPage = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "earlier-same-turn",
            text: "Earlier in the same turn",
            createdAt: 100,
          }),
          phase: "commentary" as const,
          turn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "older-page",
    });
    const refreshedTail = readThreadResponse({
      entries: [
        {
          ...messageEntry({
            id: "middle-normalized-id",
            text: "Middle of the turn",
            createdAt: 200,
          }),
          phase: "commentary" as const,
          turn,
        },
        {
          ...messageEntry({
            id: "turn-final",
            text: "Turn final",
            createdAt: 400,
          }),
          phase: "final" as const,
          turn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "middle-normalized-id",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Earlier in the same turn",
        "message:Middle of the turn",
        "message:Turn final",
      ]);
    });
  });

  it("keeps the latest page authoritative across dirty older-page overlap", async () => {
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({
          id: "tail-first",
          role: "user",
          text: "Tail first",
          createdAt: 200,
        }),
        messageEntry({
          id: "tail-last",
          text: "Tail last",
          createdAt: 300,
        }),
      ],
      hasPreviousPage: true,
      previousCursor: "tail-first",
    });
    const dirtyOlderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-entry",
          role: "user",
          text: "Older entry",
          createdAt: 100,
        }),
        messageEntry({
          id: "tail-last",
          text: "Stale tail last",
          createdAt: 300,
        }),
      ],
      hasPreviousPage: false,
    });
    const laggingRefreshedTail = readThreadResponse({
      entries: [
        messageEntry({
          id: "tail-later",
          text: "Tail later",
          createdAt: 400,
        }),
      ],
      hasPreviousPage: true,
      previousCursor: "tail-later",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(dirtyOlderPage)
      .mockResolvedValueOnce(laggingRefreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } }
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Older entry",
      "message:Tail first",
      "message:Tail last",
    ]);

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Older entry",
        "message:Tail first",
        "message:Tail last",
        "message:Tail later",
      ]);
    });
  });

  it("preserves repeated transcript content with distinct entry ids", async () => {
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({
          id: "repeat-newer",
          text: "Still working.",
          createdAt: 300,
        }),
      ],
      hasPreviousPage: true,
      previousCursor: "repeat-newer",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "repeat-older",
          text: "Still working.",
          createdAt: 200,
        }),
      ],
      hasPreviousPage: false,
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "repeat-older",
      "repeat-newer",
    ]);
  });

  it("does not prepend a post-compaction live turn ahead of refreshed history", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const completedTurn = {
      id: "turn-after-compaction",
      status: "completed" as const,
      startedAt: 500,
      completedAt: 700,
    };
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({
          id: "recent-before-compaction",
          role: "user",
          text: "Recent history",
          createdAt: 300,
        }),
      ],
      hasPreviousPage: true,
      previousCursor: "recent-before-compaction",
    });
    const olderPage = readThreadResponse({
      entries: [
        messageEntry({
          id: "older-before-compaction",
          role: "user",
          text: "Older history",
          createdAt: 100,
        }),
      ],
      hasPreviousPage: false,
    });
    const refreshedTail = readThreadResponse({
      entries: [
        messageEntry({
          id: "recent-before-compaction",
          role: "user",
          text: "Recent history",
          createdAt: 300,
        }),
        {
          ...messageEntry({
            id: "auto-fix-user",
            role: "user",
            text: "Auto-fix started",
            createdAt: 500,
          }),
          turn: completedTurn,
        },
        {
          ...messageEntry({
            id: "auto-fix-final",
            text: "Auto-fix finished",
            createdAt: 700,
          }),
          phase: "final" as const,
          turn: completedTurn,
        },
      ],
      hasPreviousPage: true,
      previousCursor: "recent-before-compaction",
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage)
      .mockResolvedValue(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender, unmount } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Older history",
      "message:Recent history",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/compacted",
          params: { threadId: "thread-1" },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: completedTurn.id,
            item: {
              id: "auto-fix-user",
              type: "userMessage",
              text: "Auto-fix started",
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Auto-fix started",
    ]);

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Recent history",
        "message:Auto-fix started",
        "message:Auto-fix finished",
      ]);
    });
    unmount();
  });

  it("invalidates loaded transcript history after a rewind notification", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [messageEntry({
          id: "discarded-message",
          role: "assistant",
          text: "Discarded branch",
          createdAt: 1_000,
        })],
        hasPreviousPage: false,
      }))
      .mockResolvedValue(readThreadResponse({
        entries: [messageEntry({
          id: "retained-message",
          role: "assistant",
          text: "Retained branch",
          createdAt: 900,
        })],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );
    await waitForThreadHydration(result);
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Discarded branch",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/rewound",
          params: {
            threadId: "thread-1",
            targetPromptIndex: 0,
            updatedAt: 2_000,
          },
        },
      });
    });
    expect(result.current.entries).toEqual([]);

    rerender({ updatedAt: 2_000 });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Retained branch",
      ]);
    });
  });

  it("releases older-history loading when a fresher hydration supersedes it", async () => {
    const initialTail = readThreadResponse({
      entries: [
        messageEntry({ id: "recent-1", text: "Recent 1", createdAt: 300 }),
      ],
      hasPreviousPage: true,
      previousCursor: "older-page",
    });
    const refreshedTail = readThreadResponse({
      entries: [
        messageEntry({ id: "recent-2", text: "Recent 2", createdAt: 400 }),
      ],
      hasPreviousPage: true,
      previousCursor: "older-page-after-refresh",
    });
    let resolveOlderPage:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    const olderPagePending = new Promise<AppServerReadThreadResponse>((resolve) => {
      resolveOlderPage = resolve;
    });
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockReturnValueOnce(olderPagePending)
      .mockResolvedValueOnce(refreshedTail);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
          thread: buildThread({ id: "thread-1", updatedAt }),
        }),
      {
        initialProps: { updatedAt: 1_000 },
      }
    );

    await waitForThreadHydration(result);
    act(() => {
      void result.current.loadOlder();
    });
    await waitFor(() => {
      expect(result.current.loadingMore).toBe(true);
      expect(readThread).toHaveBeenCalledTimes(2);
    });

    rerender({ updatedAt: 2_000 });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
      expect(result.current.response?.replay.pagination.previousCursor).toBe(
        "older-page-after-refresh",
      );
    });

    act(() => {
      resolveOlderPage?.(readThreadResponse({
        entries: [
          messageEntry({ id: "older-1", text: "Older 1", createdAt: 100 }),
        ],
        hasPreviousPage: false,
      }));
    });
    await waitFor(() => {
      expect(result.current.loadingMore).toBe(false);
    });
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Recent 2",
    ]);
  });

  it("retains transcript reading state across temporary view unmounts", async () => {
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "idle" as const,
        replay: {
          entries: [
            messageEntry({
              createdAt: 100,
              id: `${threadId}-message`,
              text: `History for ${threadId}`,
            }),
          ],
          messages: [],
          pagination: {
            supportsPagination: true,
            hasPreviousPage: false,
          },
        },
      })),
    };
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) =>
        useThreadSessionState({
          desktopApi,
          thread: buildThread({ id: threadId, updatedAt: 1_000 }),
        }),
      { initialProps: { threadId: "thread-1" } }
    );

    await waitForThreadHydration(result);
    act(() => {
      result.current.setExpandedTranscriptActivityIds(["turn-usage-1"]);
      result.current.setExpandedTranscriptWorkPhaseGroupIds(["work-group-1"]);
      result.current.setRenderedTranscriptEntryLimit(90);
      result.current.setViewport({
        distanceFromBottom: 480,
        isGluedToBottom: false,
        scrollTop: 720,
      });
    });

    rerender({ threadId: "thread-2" });
    await waitForThreadHydration(result, "thread-2");
    rerender({ threadId: "thread-1" });

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-1");
      expect(result.current.expandedTranscriptActivityIds).toEqual([
        "turn-usage-1",
      ]);
      expect(result.current.expandedTranscriptWorkPhaseGroupIds).toEqual([
        "work-group-1",
      ]);
      expect(result.current.renderedTranscriptEntryLimit).toBe(90);
      expect(result.current.viewport).toEqual({
        distanceFromBottom: 480,
        isGluedToBottom: false,
        scrollTop: 720,
      });
    });
  });

  it("rehydrates the selected thread when the initial history limit changes", async () => {
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      threadStatus: "idle" as const,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const { result, rerender } = renderHook(
      ({ initialHistoryLimit }: { initialHistoryLimit?: number }) =>
        useThreadSessionState({
          desktopApi,
          initialHistoryLimit,
          thread,
        }),
      {
        initialProps: {
          initialHistoryLimit: undefined as number | undefined,
        },
      }
    );

    await waitForThreadHydration(result);
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(readThread).toHaveBeenLastCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });

    rerender({ initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    expect(readThread).toHaveBeenLastCalledWith({
      backend: "codex",
      limit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
      threadId: "thread-1",
    });
  });

  it("rehydrates setup activity when environment runtime arrives without a timestamp change", async () => {
    const setupActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "codex-environment-setup-environment",
      summary: "Environment setup completed: Fixture Env",
      status: "completed",
      details: [],
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [],
        hasPreviousPage: false,
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [setupActivity],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const initialThread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const hydratedEnvironmentThread = buildThread({
      id: "thread-1",
      updatedAt: 1_000,
      codexEnvironmentRuntime: {
        environmentId: "environment",
        environmentName: "Fixture Env",
        executionTarget: "local",
        cwd: "/repo/worktree",
        setupStatus: "completed",
        setupCommand: "printf setup-output && sleep 2",
        setupOutput: "setup-output",
        setupExitCode: 0,
        setupDurationMs: 2_000,
      },
    });

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: initialThread,
        },
      },
    );

    await waitForThreadHydration(result);
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: hydratedEnvironmentThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toContainEqual(setupActivity);
    });
  });

  it("keeps a newer active turn busy when an older turn completion arrives", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "active" as const,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(agentEventHandler).toBeDefined();
    });

    act(() => {
      result.current.setActiveTurnId("turn-2");
      result.current.setPendingStatusText("Thinking");
    });
    expect(result.current.threadBusy).toBe(true);

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "First turn finished late." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toContain("assistant:First turn finished late.");
    });
    expect(result.current.activeTurnId).toBe("turn-2");
    expect(result.current.threadBusy).toBe(true);
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("adopts the in-progress turn from a mid-turn hydration snapshot", async () => {
    // A viewer that opens a thread mid-turn (a fresh window, or a federation
    // remote viewer) never saw turn/started. The hydrated snapshot is the only
    // signal, and without adoption the transcript collapses live commentary.
    const liveTurn = {
      id: "turn-live",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const response = readThreadResponse({
      entries: [
        {
          type: "message",
          id: "c1",
          role: "assistant",
          phase: "commentary",
          text: "Working on it.",
          turn: liveTurn,
        },
        {
          type: "activity",
          id: "tool-1",
          summary: "Used 2 tools",
          details: [],
          turn: liveTurn,
        },
      ],
      hasPreviousPage: false,
      threadStatus: "active",
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async () => response),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    expect(result.current.activeTurnId).toBe("turn-live");
    expect(result.current.activeTurnStartedAt).toBe(5_000);
  });

  it("does not adopt a stale in-progress turn from an idle hydration snapshot", async () => {
    const staleTurn = {
      id: "turn-stale",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const response = readThreadResponse({
      entries: [
        {
          type: "message",
          id: "c1",
          role: "assistant",
          phase: "commentary",
          text: "Interrupted mid-flight.",
          turn: staleTurn,
        },
      ],
      hasPreviousPage: false,
      threadStatus: "idle",
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: vi.fn(async () => response),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.activeTurnStartedAt).toBeUndefined();
  });

  it("keeps the optimistic user message ahead of the completed assistant reply", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Please fix transcript ordering.");
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              output: [{ type: "text", text: "Transcript ordering is fixed." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "user:Please fix transcript ordering.",
        "assistant:Transcript ordering is fixed.",
      ]);
    });

    expect(
      result.current.response?.replay.messages.map(
        (message) => `${message.role}:${message.text}`
      )
    ).toEqual([
      "assistant:Loaded thread-1",
      "user:Please fix transcript ordering.",
      "assistant:Transcript ordering is fixed.",
    ]);
  });

  it("materializes a started user message before assistant output", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async () => readThreadResponse({
        entries: [],
        hasPreviousPage: false,
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            turn: {
              id: "turn-2",
              status: "in_progress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            item: {
              id: "user-message-2",
              type: "userMessage",
              content: [{ type: "text", text: "Run the corrected command." }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            item: {
              id: "user-message-2",
              type: "userMessage",
              content: [{ type: "text", text: "Run the corrected command." }],
            },
          },
        },
      });
    });

    act(() => {
      result.current.addOptimisticUserMessage(
        "Run the corrected command.",
        [],
        "turn-2",
      );
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            item: {
              id: "assistant-message-2",
              type: "agentMessage",
              text: "The corrected command is running.",
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "user:Run the corrected command.",
      "assistant:The corrected command is running.",
    ]);
  });

  it("does not duplicate a final reported by both item and turn completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async () => readThreadResponse({
        entries: [],
        hasPreviousPage: false,
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-final-1",
              type: "agentMessage",
              phase: "final_answer",
              text: "Sent.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Sent." }],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.filter(
        (entry) =>
          entry.type === "message"
          && entry.role === "assistant"
          && entry.text === "Sent."
      )
    ).toHaveLength(1);
  });

  it("replaces a promoted optimistic user message when the completed user item arrives later", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => {
      now += 10;
      return now;
    });
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.addOptimisticUserMessage("Please fix transcript ordering.");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-message-1",
              type: "agentMessage",
              text: "Working on it.",
            },
          },
        },
      });
    });

    expect(result.current.response?.replay.messages).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^optimistic-/),
        role: "user",
        text: "Please fix transcript ordering.",
      }),
      expect.objectContaining({
        id: "assistant-message-1",
        role: "assistant",
        text: "Working on it.",
      }),
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "user-message-1",
              type: "userMessage",
              origin: {
                kind: "agent",
                sourceThread: {
                  backend: "codex",
                  instanceId: "pwr_source",
                  instanceLabel: "Source Mac",
                  celestialIcon: "moon",
                  threadId: "parent-thread",
                  title: "Parent thread",
                },
              },
              content: [
                {
                  type: "text",
                  text: "Please fix transcript ordering.",
                },
              ],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.id}:${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "user-message-1:user:Please fix transcript ordering.",
      "assistant-message-1:assistant:Working on it.",
    ]);
    expect(
      result.current.response?.replay.messages.filter(
        (message) =>
          message.role === "user" &&
          message.text === "Please fix transcript ordering."
      )
    ).toEqual([
      expect.objectContaining({
        id: "user-message-1",
        origin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            instanceId: "pwr_source",
            instanceLabel: "Source Mac",
            celestialIcon: "moon",
            threadId: "parent-thread",
            title: "Parent thread",
          },
        },
      }),
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            item: {
              id: "user-message-2",
              type: "userMessage",
              origin: {
                kind: "messaging",
                messaging: {
                  platform: "slack",
                  sourceUrl:
                    "https://pwrdrvr.slack.com/archives/C012ABCDEF0/p1712023030000000",
                  surface: {
                    id: "message-thread-1",
                    kind: "thread",
                    title: "api-search circuit breaker timeout",
                    parentTitle: "signals-chat",
                    ancestorTitle: "PwrAgent",
                  },
                  actor: {
                    platformUserId: "U012345",
                    displayName: "Hunter",
                    username: "fixtureuser",
                  },
                },
              },
              content: [
                {
                  type: "text",
                  text: "Go for it.",
                },
              ],
            },
          },
        },
      });
    });

    expect(
      result.current.response?.replay.messages.find(
        (message) => message.id === "user-message-2",
      ),
    ).toEqual(
      expect.objectContaining({
        origin: {
          kind: "messaging",
          messaging: {
            platform: "slack",
            sourceUrl:
              "https://pwrdrvr.slack.com/archives/C012ABCDEF0/p1712023030000000",
            surface: {
              id: "message-thread-1",
              kind: "thread",
              title: "api-search circuit breaker timeout",
              parentTitle: "signals-chat",
              ancestorTitle: "PwrAgent",
            },
            actor: {
              platformUserId: "U012345",
              displayName: "Hunter",
              username: "fixtureuser",
            },
          },
        },
      }),
    );
  });

  it("preserves live agent provenance when an earlier hydration finishes later", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let resolveReadThread:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    const readThread = vi.fn(
      async () =>
        await new Promise<AppServerReadThreadResponse>((resolve) => {
          resolveReadThread = resolve;
        })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(agentEventHandler).toBeDefined();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "injected-message",
              type: "userMessage",
              origin: {
                kind: "agent",
                sourceThread: {
                  backend: "codex",
                  threadId: "source-thread",
                  title: "Source thread",
                },
              },
              content: [{ type: "text", text: "Please continue the audit." }],
            },
          },
        },
      });
    });

    await act(async () => {
      resolveReadThread?.(
        readThreadResponse({
          entries: [
            {
              type: "message",
              id: "injected-message",
              role: "user",
              text: "Please continue the audit.",
            },
          ],
          hasPreviousPage: false,
        })
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(result.current.response?.threadStatus).toBe("idle");
    });
    expect(
      result.current.response?.replay.entries.find(
        (entry) => entry.id === "injected-message",
      ),
    ).toEqual(
      expect.objectContaining({
        origin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "source-thread",
            title: "Source thread",
          },
        },
      }),
    );
    expect(
      result.current.response?.replay.messages.find(
        (message) => message.id === "injected-message",
      ),
    ).toEqual(
      expect.objectContaining({
        origin: {
          kind: "agent",
          sourceThread: {
            backend: "codex",
            threadId: "source-thread",
            title: "Source thread",
          },
        },
      }),
    );
  });

  it("keeps a live sub-agent message attributed to its source thread", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-monitor",
            item: {
              id: "monitor-result",
              type: "userMessage",
              origin: {
                kind: "sub-agent",
                sourceThread: {
                  backend: "codex",
                  threadId: "monitor-thread",
                  title: "Watch CI",
                },
                subAgent: {
                  kind: "monitor",
                  monitorId: "monitor-1",
                  task: "Watch CI",
                  outcome: "success",
                  summary: "All required checks passed.",
                },
              },
              content: [{ type: "text", text: "All required checks passed." }],
            },
          },
        },
      });
    });

    expect(
      result.current.response?.replay.messages.find(
        (message) => message.id === "monitor-result",
      ),
    ).toEqual(
      expect.objectContaining({
        origin: {
          kind: "sub-agent",
          sourceThread: {
            backend: "codex",
            threadId: "monitor-thread",
            title: "Watch CI",
          },
          subAgent: {
            kind: "monitor",
            monitorId: "monitor-1",
            task: "Watch CI",
            outcome: "success",
            summary: "All required checks passed.",
          },
        },
      }),
    );
  });

  it("replaces a launchpad placeholder when its user-message item completes", async () => {
    const launchpadText =
      "https://github.com/pwrdrvr/PwrSnap/pull/407 - Update the TanStack Virtual lockfile.";
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
          optimisticUserMessage: {
            text: launchpadText,
            createdAt: 1_000,
          },
          optimisticActiveTurn: {
            id: "turn-1",
            statusText: "Thinking",
            startedAt: 2_000,
          },
        },
      })
    );

    await waitForThreadHydration(result);
    await waitFor(() => {
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          id: "optimistic-launchpad-codex:thread-1",
          role: "user",
          text: launchpadText,
        }),
      ]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "item-1",
              type: "userMessage",
              text: launchpadText,
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([
      expect.objectContaining({
        id: "item-1",
        role: "user",
        text: launchpadText,
        turn: expect.objectContaining({ id: "turn-1" }),
      }),
    ]);
  });

  it("keeps the launchpad prompt visible while messages hydrate ahead of entries", async () => {
    const launchpadText = "Keep this prompt visible while the turn starts.";
    const desktopApi: DesktopApi = {
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-commentary",
              role: "assistant" as const,
              phase: "commentary" as const,
              text: "I am starting the investigation.",
              createdAt: 2_000,
            },
          ],
          messages: [
            {
              id: "hydrated-user",
              role: "user" as const,
              text: launchpadText,
              createdAt: 1_000,
            },
            {
              id: "assistant-commentary",
              role: "assistant" as const,
              phase: "commentary" as const,
              text: "I am starting the investigation.",
              createdAt: 2_000,
            },
          ],
          pagination: {
            supportsPagination: true,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result, rerender } = renderHook(
      ({ includeLaunchpadState }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
            ...(includeLaunchpadState
              ? {
                  optimisticUserMessage: {
                    text: launchpadText,
                    createdAt: 1_000,
                  },
                  optimisticActiveTurn: {
                    id: "turn-1",
                    statusText: "Thinking",
                    startedAt: 1_000,
                  },
                }
              : {}),
          },
        }),
      { initialProps: { includeLaunchpadState: true } },
    );

    await waitForThreadHydration(result);
    rerender({ includeLaunchpadState: false });
    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        `user:${launchpadText}`,
        "assistant:I am starting the investigation.",
      ]);
    });
    expect(
      result.current.messages.filter((message) => message.role === "user")
    ).toHaveLength(1);
  });

  it("keeps identical user messages from different turns in the message projection", async () => {
    const launchpadText = "Run the same verification again.";
    const desktopApi: DesktopApi = {
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "previous-user",
              role: "user" as const,
              text: launchpadText,
              createdAt: 500,
              turn: {
                id: "turn-previous",
                status: "completed" as const,
              },
            },
            {
              type: "message" as const,
              id: "assistant-commentary",
              role: "assistant" as const,
              phase: "commentary" as const,
              text: "I am starting the new verification.",
              createdAt: 2_000,
              turn: {
                id: "turn-1",
                status: "in_progress" as const,
                startedAt: 1_000,
              },
            },
          ],
          messages: [
            {
              id: "previous-user",
              role: "user" as const,
              text: launchpadText,
              createdAt: 500,
            },
            {
              id: "assistant-commentary",
              role: "assistant" as const,
              phase: "commentary" as const,
              text: "I am starting the new verification.",
              createdAt: 2_000,
            },
          ],
          pagination: {
            supportsPagination: true,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result, rerender } = renderHook(
      ({ includeLaunchpadState }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
            ...(includeLaunchpadState
              ? {
                  optimisticUserMessage: {
                    text: launchpadText,
                    createdAt: 1_000,
                  },
                  optimisticActiveTurn: {
                    id: "turn-1",
                    statusText: "Thinking",
                    startedAt: 1_000,
                  },
                }
              : {}),
          },
        }),
      { initialProps: { includeLaunchpadState: true } },
    );

    await waitForThreadHydration(result);
    rerender({ includeLaunchpadState: false });
    await waitFor(() => {
      expect(
        result.current.entries
          .filter((entry) => entry.type === "message" && entry.role === "user")
          .map((entry) => entry.id)
      ).toEqual([
        "previous-user",
        "optimistic-launchpad-codex:thread-1",
      ]);
    });
    expect(
      result.current.messages
        .filter((message) => message.role === "user")
        .map((message) => message.id)
    ).toEqual([
      "previous-user",
      "optimistic-launchpad-codex:thread-1",
    ]);
  });

  it("keeps a duplicate optimistic user message when the launch item completes", async () => {
    const messageText = "Please update the TanStack Virtual lockfile.";
    let authoritativeEntries: AppServerThreadEntry[] = [];
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async () => readThreadResponse({
        entries: authoritativeEntries,
        hasPreviousPage: false,
        supportsPagination: false,
      }),
    };
    const { result, rerender } = renderHook(
      ({ updatedAt }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt }),
            optimisticUserMessage: {
              text: messageText,
              createdAt: 1_000,
            },
            optimisticActiveTurn: {
              id: "turn-1",
              statusText: "Thinking",
              startedAt: 2_000,
            },
          },
        }),
      { initialProps: { updatedAt: 2_000 } },
    );

    await waitForThreadHydration(result);
    let duplicateOptimisticId = "";
    act(() => {
      duplicateOptimisticId = result.current.addOptimisticUserMessage(messageText);
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "item-1",
              type: "userMessage",
              text: messageText,
            },
          },
        },
      });
    });

    const userEntries = result.current.entries.filter(
      (entry): entry is AppServerThreadMessageEntry =>
        entry.type === "message" && entry.role === "user"
    );
    expect(userEntries).toHaveLength(2);
    expect(userEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "item-1",
          text: messageText,
          turn: expect.objectContaining({ id: "turn-1" }),
        }),
        expect.objectContaining({
          id: duplicateOptimisticId,
          text: messageText,
        }),
      ])
    );

    authoritativeEntries = [
      userEntries.find((entry) => entry.id === "item-1")!,
    ];
    rerender({ updatedAt: 3_000 });

    await waitFor(() => {
      const hydratedUserEntryIds = result.current.entries
        .filter((entry) => entry.type === "message" && entry.role === "user")
        .map((entry) => entry.id);
      expect(hydratedUserEntryIds).toHaveLength(2);
      expect(hydratedUserEntryIds).toEqual(
        expect.arrayContaining(["item-1", duplicateOptimisticId])
      );
    });
  });

  it("does not reconcile a launchpad placeholder with another turn's identical user message", async () => {
    const messageText = "Please update the TanStack Virtual lockfile.";
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
          optimisticUserMessage: {
            text: messageText,
            createdAt: 1_000,
          },
          optimisticActiveTurn: {
            id: "turn-1",
            statusText: "Thinking",
            startedAt: 1_000,
          },
        },
      })
    );

    await waitForThreadHydration(result);
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            item: {
              id: "item-turn-2",
              type: "userMessage",
              text: messageText,
            },
          },
        },
      });
    });

    const userEntryIds = result.current.entries
      .filter((entry) => entry.type === "message" && entry.role === "user")
      .map((entry) => entry.id);
    expect(userEntryIds).toHaveLength(2);
    expect(userEntryIds).toEqual(
      expect.arrayContaining([
        "optimistic-launchpad-codex:thread-1",
        "item-turn-2",
      ])
    );
  });

  it("keeps an optimistic image user message ahead of a hydrated assistant final", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => {
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: "assistant-final",
                role: "assistant" as const,
                phase: "final" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 2_000,
              },
            ],
            messages: [
              {
                id: "assistant-final",
                role: "assistant" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 2_000,
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );
    const desktopApi: DesktopApi = { readThread };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 2_000 }),
          optimisticUserMessage: {
            text: "What's in this image?",
            createdAt: 1_000,
            imageParts: [{ type: "image", url: "data:image/png;base64,AQID" }],
          },
        },
      })
    );

    await waitForThreadHydration(result);
    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "user:What's in this image?",
        "assistant:It is a screenshot of PwrAgent.",
      ]);
    });
    expect(
      result.current.messages.map((message) => `${message.role}:${message.text}`)
    ).toEqual([
      "user:What's in this image?",
      "assistant:It is a screenshot of PwrAgent.",
    ]);
  });

  it("deduplicates hydrated image prompt wrappers against selected optimistic input", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => {
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: "hydrated-user",
                role: "user" as const,
                text: "What's in this image?\n\n<image name=[Image #1]>\n\n</image>",
                parts: [
                  { type: "text" as const, text: "What's in this image?" },
                  { type: "text" as const, text: "<image name=[Image #1]>" },
                  { type: "image" as const, url: "file:///tmp/materialized.png" },
                  { type: "text" as const, text: "</image>" },
                ],
                createdAt: 2_000,
              },
              {
                type: "message" as const,
                id: "assistant-final",
                role: "assistant" as const,
                phase: "final" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 3_000,
              },
            ],
            messages: [
              {
                id: "hydrated-user",
                role: "user" as const,
                text: "What's in this image?\n\n<image name=[Image #1]>\n\n</image>",
                parts: [
                  { type: "text" as const, text: "What's in this image?" },
                  { type: "text" as const, text: "<image name=[Image #1]>" },
                  { type: "image" as const, url: "file:///tmp/materialized.png" },
                  { type: "text" as const, text: "</image>" },
                ],
                createdAt: 2_000,
              },
              {
                id: "assistant-final",
                role: "assistant" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 3_000,
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );
    const desktopApi: DesktopApi = { readThread };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 3_000 }),
          optimisticUserMessage: {
            text: "What's in this image?",
            createdAt: 1_000,
            imageParts: [{ type: "image", url: "data:image/png;base64,AQID" }],
          },
        },
      })
    );

    await waitForThreadHydration(result);
    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "user:What's in this image?",
        "assistant:It is a screenshot of PwrAgent.",
      ]);
    });
    const [userEntry] = result.current.entries;
    expect(userEntry).toMatchObject({
      type: "message",
      role: "user",
      text: "What's in this image?",
      parts: [
        { type: "text", text: "What's in this image?" },
        { type: "image", url: "file:///tmp/materialized.png" },
      ],
    });
  });

  it("preserves selected optimistic image input when hydrated prompt is text-only", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => {
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: "hydrated-user",
                role: "user" as const,
                text: "what's in this?",
                createdAt: 2_000,
              },
              {
                type: "message" as const,
                id: "assistant-final",
                role: "assistant" as const,
                phase: "final" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 3_000,
              },
            ],
            messages: [
              {
                id: "hydrated-user",
                role: "user" as const,
                text: "what's in this?",
                createdAt: 2_000,
              },
              {
                id: "assistant-final",
                role: "assistant" as const,
                text: "It is a screenshot of PwrAgent.",
                createdAt: 3_000,
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );
    const desktopApi: DesktopApi = { readThread };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 3_000 }),
          optimisticUserMessage: {
            text: "what's in this?",
            createdAt: 1_000,
            imageParts: [{ type: "image", url: "data:image/png;base64,AQID" }],
          },
        },
      })
    );

    await waitForThreadHydration(result);
    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "user:what's in this?",
        "assistant:It is a screenshot of PwrAgent.",
      ]);
    });
    const [userEntry] = result.current.entries;
    expect(userEntry).toMatchObject({
      type: "message",
      role: "user",
      text: "what's in this?",
      parts: [
        { type: "text", text: "what's in this?" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
    });
  });

  it("materializes completed steer user messages in the transcript", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Steer while thinking.");
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "userMessage",
              id: "steer-message-1",
              content: [
                {
                  type: "text",
                  text: "Steer while thinking.",
                },
              ],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "user:Steer while thinking.",
      ]);
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              output: [{ type: "text", text: "Steer acknowledged." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "user:Steer while thinking.",
        "assistant:Steer acknowledged.",
      ]);
    });
  });

  it("preserves optimistic image attachments when Codex echoes a text-only user message", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.addOptimisticUserMessage("What's in this image?", [
        { type: "image", url: "data:image/png;base64,AQID" },
      ]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "userMessage",
              id: "user-message-1",
              content: [
                {
                  type: "text",
                  text: "What's in this image?",
                },
              ],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual(["user:What's in this image?"]);
    });
    const [entry] = result.current.entries;
    expect(entry).toMatchObject({
      type: "message",
      role: "user",
      text: "What's in this image?",
      parts: [
        { type: "text", text: "What's in this image?" },
        { type: "image", url: "data:image/png;base64,AQID" },
      ],
    });
  });

  it("reconciles redacted PDF file references and hidden PDF context to the Composer entry", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    const composerText = "Compare [@Jeep](~/Downloads/Jeep).";
    act(() => {
      result.current.addOptimisticUserMessage(composerText);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "userMessage",
              id: "user-message-1",
              content: [
                {
                  type: "text",
                  text: [
                    "Compare @Jeep.",
                    "<pwragent-pdf-context>",
                    "PwrAgent owns this local PDF.",
                    "</pwragent-pdf-context>",
                  ].join("\n\n"),
                },
              ],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          id: "user-message-1",
          role: "user",
          text: composerText,
          parts: [{ type: "text", text: composerText }],
        }),
      ]);
    });
  });

  it("keeps live protocol activity before hydrated review output after completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Review the branch.",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Review the branch.",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Review the branch.",
              },
              {
                type: "review" as const,
                id: "review-result",
                review: "Review finding.",
                turn: {
                  id: "review-turn",
                  status: "completed" as const,
                  durationMs: 211_000,
                },
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Review the branch.",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    const liveActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "live-tools-review-turn",
      createdAt: 1_100,
      summary: "Used 2 tools",
      status: "in_progress",
      details: [
        {
          id: "cmd-1",
          kind: "read",
          label: "Read SKILL.md",
          status: "completed",
        },
      ],
      turn: {
        id: "review-turn",
        status: "in_progress",
        startedAt: 1_050,
      },
    };

    act(() => {
      result.current.upsertLiveTranscriptEntry(liveActivity);
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "review-turn",
            turn: {
              id: "review-turn",
              status: "completed",
              output: [],
              durationMs: 211_000,
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "thread-1-message-1",
        "live-tools-review-turn",
        "review-result",
      ]);
    });
    expect(result.current.entries[1]).toMatchObject({
      type: "activity",
      summary: "Used 2 tools",
      turn: {
        id: "review-turn",
        status: "completed",
        durationMs: 211_000,
      },
    });
  });

  it("materializes a new thread in user-then-assistant order on completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-empty", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Start a new ordered thread.");
    });

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-empty",
            turnId: "turn-2",
            turn: {
              output: [{ type: "text", text: "The new thread is ordered." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
        )
      ).toEqual([
        "user:Start a new ordered thread.",
        "assistant:The new thread is ordered.",
      ]);
    });
  });

  it("preserves multiple streamed assistant messages before the final answer", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(result.current.pendingAssistantMessage?.text).toBe("First commentary.");
    expect(result.current.pendingAssistantMessage?.phase).toBe("commentary");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual(["assistant:First commentary."]);
    expect(result.current.pendingAssistantMessage?.text).toBe("Second commentary.");
    expect(result.current.pendingAssistantMessage?.phase).toBe("commentary");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 524_447,
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "assistant:First commentary.",
      "assistant:Second commentary.",
      "assistant:Final answer.",
    ]);
    expect(
      result.current.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.phase)
    ).toEqual(["commentary", "commentary", "final"]);
    expect(
      result.current.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.turn)
    ).toEqual([
      { id: "turn-1", status: "completed", durationMs: 524_447 },
      { id: "turn-1", status: "completed", durationMs: 524_447 },
      { id: "turn-1", status: "completed", durationMs: 524_447 },
    ]);
    expect(result.current.pendingAssistantMessage).toBeUndefined();
  });

  it("replaces a transient message without persisting it in the transcript", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "in_progress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient-thought:turn-1",
            role: "assistant",
            text: "So the key logic is:",
            phase: "commentary",
          },
        },
      });
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.transientMessage).toMatchObject({
      id: "transient-thought:turn-1",
      role: "assistant",
      text: "So the key logic is:",
      type: "transientMessage",
    });
    expect(result.current.transientMessages).toHaveLength(1);
    expect(result.current.pendingAssistantMessage).toBeUndefined();
    expect(result.current.messages).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient-thought:turn-1",
            role: "assistant",
            text: "Tracing the image support flags.",
            phase: "commentary",
          },
        },
      });
    });

    expect(result.current.transientMessage?.text).toBe(
      "Tracing the image support flags."
    );
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Tracing the image support flags.",
    ]);
    expect(result.current.messages).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient-thought:turn-1",
            role: "assistant",
            text: "",
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient-thought:turn-1",
            role: "assistant",
            text: "Inspecting the relevant file.",
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "sed -n '1,40p' src/one.ts",
              commandActions: [{ type: "read", path: "src/one.ts" }],
            },
          },
        },
      });
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Inspecting the relevant file.",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient-thought:turn-1",
            role: "assistant",
            text: "Found the relevant branch.",
            phase: "commentary",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "The image flag is disabled.",
            phase: "final",
          },
        },
      });
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.pendingAssistantMessage?.text).toBe(
      "The image flag is disabled."
    );
    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Inspecting the relevant file.",
      "Found the relevant branch.",
    ]);
    expect(
      result.current.messages.some((message) =>
        message.text.includes("Found the relevant branch.")
      )
    ).toBe(false);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "The image flag is disabled." }],
            },
          },
        },
      });
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Inspecting the relevant file.",
      "Found the relevant branch.",
    ]);
    expect(
      result.current.messages.map((message) => message.text)
    ).toEqual(["The image flag is disabled."]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/compacted",
          params: {
            threadId: "thread-1",
          },
        },
      });
    });

    expect(result.current.transientMessages).toEqual([]);

    act(() => {
      for (let index = 1; index <= 51; index += 1) {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "item/transientMessage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-cap",
              itemId: "transient-thought:turn-cap",
              role: "assistant",
              text: `Ephemeral segment ${index}.`,
              phase: "commentary",
            },
          },
        });
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-cap",
              item: {
                id: `read-${index}`,
                type: "commandExecution",
                command: `sed -n '${index}p' src/file.ts`,
                commandActions: [{ type: "read", path: "src/file.ts" }],
              },
            },
          },
        });
      }
    });

    expect(result.current.transientMessages).toHaveLength(50);
    expect(result.current.transientMessages[0]?.text).toBe(
      "Ephemeral segment 2.",
    );
    expect(result.current.transientMessages[49]?.text).toBe(
      "Ephemeral segment 51.",
    );
    expect(result.current.messages).toEqual([]);
  });

  it("isolates transient messages by thread and turn", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };
    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_000 });
    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread1,
        },
      }
    );

    await waitForThreadHydration(result, "thread-1");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient:turn-1",
            role: "assistant",
            text: "Thread one thought.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-2",
            turnId: "turn-2",
            itemId: "transient:turn-2",
            role: "assistant",
            text: "Thread two thought.",
          },
        },
      });
    });

    expect(result.current.transientMessage?.text).toBe("Thread one thought.");
    expect(result.current.entries).toEqual([]);
    expect(result.current.messages).toEqual([]);

    rerender({ currentThread: thread2 });
    await waitForThreadHydration(result, "thread-2");

    expect(result.current.transientMessage?.text).toBe("Thread two thought.");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-2",
            turnId: "turn-3",
            turn: {
              id: "turn-3",
              status: "in_progress",
            },
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Thread two thought.",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-2",
            turnId: "turn-2",
            itemId: "transient:turn-2",
            role: "assistant",
            text: "Late thought from the previous turn.",
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Thread two thought.",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-2",
            turnId: "turn-3",
            itemId: "transient:turn-3",
            role: "assistant",
            text: "Current turn thought.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-2",
            turnId: "turn-2",
            turn: {
              id: "turn-2",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    expect(result.current.transientMessage?.text).toBe("Current turn thought.");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: "thread-2",
            turnId: "turn-3",
            turn: {
              id: "turn-3",
              status: "cancelled",
            },
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Thread two thought.",
      "Current turn thought.",
    ]);

    rerender({ currentThread: thread1 });
    await waitForThreadHydration(result, "thread-1");

    expect(result.current.transientMessage?.text).toBe("Thread one thought.");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Thread one thought.",
    ]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/transientMessage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "transient:turn-1",
            role: "assistant",
            text: "Thought before approval.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            requestId: "approval-1",
          },
        },
      });
    });

    expect(result.current.transientMessage).toBeUndefined();
    expect(result.current.transientMessages.map((message) => message.text)).toEqual([
      "Thread one thought.",
      "Thought before approval.",
    ]);
    expect(result.current.pendingStatusText).toBe("Waiting for approval");
  });

  it("retimestamps streamed final assistant messages when the turn completes", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              startedAt: 1_763_500_100_000,
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "final-message",
            delta: "Final answer.",
            phase: "final",
          },
        },
      });
    });

    const pendingCreatedAt = result.current.pendingAssistantMessage?.createdAt;
    expect(pendingCreatedAt).toEqual(expect.any(Number));
    expect(pendingCreatedAt).not.toBe(1_763_500_520_000);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              startedAt: 1_763_500_100_000,
              completedAt: 1_763_500_520_000,
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([
      expect.objectContaining({
        type: "message",
        id: "final-message",
        role: "assistant",
        phase: "final",
        text: "Final answer.",
        createdAt: 1_763_500_520_000,
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
          startedAt: 1_763_500_100_000,
          completedAt: 1_763_500_520_000,
        }),
      }),
    ]);
    expect(result.current.pendingAssistantMessage).toBeUndefined();
  });

  it("renders completed assistant message items without waiting for a transcript reread", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "user" as const,
              text: "Automation run metadata...",
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "user" as const,
              text: "Automation run metadata...",
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-message-1",
              type: "agentMessage",
              phase: "final_answer",
              text: "The automation result is ready.",
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "user:Automation run metadata...",
      "assistant:The automation result is ready.",
    ]);
    expect(
      result.current.entries.find(
        (entry) => entry.type === "message" && entry.role === "assistant"
      )
    ).toMatchObject({
      id: "assistant-message-1",
      phase: "final",
      turn: { id: "turn-1", status: "in_progress" },
    });
    expect(readThread).toHaveBeenCalledTimes(1);
  });

  it("keeps transient task monitor progress out of the transcript", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-1");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "monitor:monitor-1",
            item: {
              id: "monitor-progress-1",
              type: "agentMessage",
              text: "Still running.",
              data: {
                source: "pwragent_task_monitor",
                monitorId: "monitor-1",
                monitorUsage: {
                  phase: "progress",
                  model: "gpt-5.4-mini",
                  tokenUsage: {
                    inputTokens: 1_000,
                    cachedInputTokens: 200,
                    outputTokens: 50,
                    reasoningOutputTokens: 10,
                  },
                },
                transient: true,
              },
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "monitor:monitor-1",
            item: {
              id: "monitor-progress-usage-1",
              type: "taskMonitorUsage",
              data: {
                source: "pwragent_task_monitor",
                monitorId: "monitor-1",
                monitorUsage: {
                  phase: "progress",
                  model: "gpt-5.4-mini",
                  tokenUsage: {
                    inputTokens: 2_000,
                    cachedInputTokens: 400,
                    outputTokens: 100,
                    reasoningOutputTokens: 20,
                  },
                },
                transient: true,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([]);
  });

  it("keeps completion monitor usage as top-level activity after hydration", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let readCount = 0;
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => {
        readCount += 1;
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries:
              readCount === 1
                ? []
                : [
                    {
                      type: "message" as const,
                      id: "assistant-final",
                      role: "assistant" as const,
                      text: "Parent processed monitor result.",
                      createdAt: 20_000,
                      turn: {
                        id: "parent-turn-1",
                        status: "completed" as const,
                      },
                    },
                  ],
            messages:
              readCount === 1
                ? []
                : [
                    {
                      id: "assistant-final",
                      role: "assistant" as const,
                      text: "Parent processed monitor result.",
                      createdAt: 20_000,
                    },
                  ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const initialThread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const updatedThread = buildThread({ id: "thread-1", updatedAt: 2_000 });
    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: initialThread,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-1");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "monitor:monitor-1",
            item: {
              id: "monitor-completion-usage-1",
              type: "taskMonitorUsage",
              data: {
                source: "pwragent_task_monitor",
                monitorId: "monitor-1",
                monitorUsage: {
                  phase: "completion",
                  model: "gpt-5.4-mini",
                  tokenUsage: {
                    inputTokens: 1_000,
                    cachedInputTokens: 200,
                    outputTokens: 50,
                    reasoningOutputTokens: 10,
                  },
                },
                transient: false,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Monitor usage: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
    ]);

    rerender({ currentThread: updatedThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "activity:Monitor usage: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
        "message:Parent processed monitor result.",
      ]);
    });
  });

  it("persists completion monitor usage as durable transcript metadata", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    const persistThreadUsageActivity = vi.fn(async ({ backend, threadId, activity }) => ({
      backend,
      threadId,
      activityId: activity.id,
      persisted: true,
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      persistThreadUsageActivity,
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "monitor:monitor-1",
            item: {
              id: "monitor-completion-usage-1",
              type: "taskMonitorUsage",
              data: {
                source: "pwragent_task_monitor",
                monitorId: "monitor-1",
                monitorUsage: {
                  phase: "completion",
                  model: "gpt-5.4-mini",
                  tokenUsage: {
                    inputTokens: 1_000,
                    cachedInputTokens: 200,
                    outputTokens: 50,
                    reasoningOutputTokens: 10,
                  },
                },
                transient: false,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Monitor usage: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
    ]);
    expect(persistThreadUsageActivity).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      activity: expect.objectContaining({
        id: "monitor-completion-usage-1:usage",
        summary:
          "Monitor usage: 800 uncached in · 200 cached · 50 out (10 reasoning) · <$0.001 list price",
      }),
    });
  });

  it("keeps live read activity in receipt order between assistant messages", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "sed -n '1,40p' src/one.ts",
              commandActions: [{ type: "read", path: "src/one.ts" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "The first scan shows this is a deep brainstorm.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-2",
              type: "commandExecution",
              command: "rg -n transcript src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message"
          ? `message:${entry.text}`
          : entry.type === "activity"
            ? `activity:${entry.summary}`
            : entry.type
      )
    ).toEqual([
      "message:First commentary.",
      "activity:Read one.ts",
      "message:The first scan shows this is a deep brainstorm.",
      "activity:Searched src",
      "message:Final answer.",
    ]);
    expect(
      result.current.entries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.phase)
    ).toEqual(["commentary", "commentary", "final"]);
  });

  it("preserves live receipt order when consecutive events share a wall-clock millisecond", async () => {
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            phase: "final",
            delta: "First commentary.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "rg first src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            phase: "final",
            delta: "Second commentary.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-2",
              type: "commandExecution",
              command: "rg second src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-3",
            delta: "Third commentary.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: { id: "turn-1", status: "completed", durationMs: 70_000 },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message"
          ? `message:${entry.text}`
          : entry.type === "activity"
            ? `activity:${entry.summary}`
            : entry.type
      )
    ).toEqual([
      "message:First commentary.",
      "activity:Searched src",
      "message:Second commentary.",
      "activity:Searched src",
      "message:Third commentary.",
    ]);
  });

  it("starts a new live activity bucket after assistant messages completed into the response", async () => {
    let now = 80_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "sed -n '1,40p' src/one.ts",
              commandActions: [{ type: "read", path: "src/one.ts" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "message-1",
              type: "agentMessage",
              phase: "commentary",
              text: "Starting to look through the project.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-2",
              type: "commandExecution",
              command: "rg -n transcript src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message"
          ? `message:${entry.text}`
          : entry.type === "activity"
            ? `activity:${entry.summary}:${entry.details.length}`
            : entry.type
      )
    ).toEqual([
      "activity:Read one.ts:1",
      "message:Starting to look through the project.",
      "activity:Searched src:1",
    ]);
  });

  it("keeps live activity between assistant messages after coarse hydration", async () => {
    let now = 30_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const completedTurn = {
      id: "turn-1",
      status: "completed" as const,
      durationMs: 70_000,
    };
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: "message-1",
                role: "assistant" as const,
                phase: "commentary" as const,
                text: "First commentary.",
                createdAt: 1_000,
                turn: completedTurn,
              },
              {
                type: "message" as const,
                id: "message-2",
                role: "assistant" as const,
                phase: "commentary" as const,
                text: "Second commentary.",
                createdAt: 1_000,
                turn: completedTurn,
              },
              {
                type: "message" as const,
                id: "turn-1:assistant",
                role: "assistant" as const,
                phase: "final" as const,
                text: "Final answer.",
                createdAt: 1_000,
                turn: completedTurn,
              },
            ],
            messages: [
              {
                id: "message-1",
                role: "assistant" as const,
                text: "First commentary.",
                createdAt: 1_000,
              },
              {
                id: "message-2",
                role: "assistant" as const,
                text: "Second commentary.",
                createdAt: 1_000,
              },
              {
                id: "turn-1:assistant",
                role: "assistant" as const,
                text: "Final answer.",
                createdAt: 1_000,
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
              startedAt: 1_000,
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "sed -n '1,40p' src/one.ts",
              commandActions: [{ type: "read", path: "src/one.ts" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-2",
              type: "commandExecution",
              command: "rg -n transcript src",
              commandActions: [{ type: "search", path: "src" }],
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              durationMs: 70_000,
              output: [{ type: "text", text: "Final answer." }],
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:First commentary.",
      "activity:Read one.ts",
      "message:Second commentary.",
      "activity:Searched src",
      "message:Final answer.",
    ]);

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:First commentary.",
        "activity:Read one.ts",
        "message:Second commentary.",
        "activity:Searched src",
        "message:Final answer.",
      ]);
    });
  });

  it("keeps an observed prompt above hydrated work after a completed-turn refresh", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const liveTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 1_000,
    };
    const completedTurn = {
      id: "turn-1",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 5_000,
      durationMs: 4_000,
    };
    const readThread = vi
      .fn()
      .mockImplementationOnce(async ({ threadId }) =>
        readThreadResponse({
          entries: [],
          hasPreviousPage: false,
          supportsPagination: false,
          threadId,
        })
      )
      .mockImplementationOnce(async ({ threadId }) =>
        readThreadResponse({
          // Codex can return the just-finished tool aggregate before the
          // initiating prompt. The renderer had already observed the prompt
          // before the work, so this weaker hydration order must not win.
          entries: [
            {
              type: "activity" as const,
              id: "hydrated-tools",
              summary: "Used 1 tool",
              createdAt: 2_000,
              details: [
                {
                  id: "tool-1",
                  kind: "command" as const,
                  label: "Read the latest screenshot",
                  status: "completed" as const,
                },
              ],
              turn: completedTurn,
            },
            {
              type: "message" as const,
              id: "hydrated-user",
              role: "user" as const,
              text: "Show me the latest screenshot.",
              createdAt: 1_000,
              turn: completedTurn,
            },
            {
              type: "message" as const,
              id: "hydrated-commentary",
              role: "assistant" as const,
              phase: "commentary" as const,
              text: "I will fetch the latest capture.",
              createdAt: 1_500,
              turn: completedTurn,
            },
            {
              type: "message" as const,
              id: "hydrated-final",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Here it is.",
              createdAt: 5_000,
              turn: completedTurn,
            },
          ],
          hasPreviousPage: false,
          supportsPagination: false,
          threadId,
        })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(
      ({ thread }) => useThreadSessionState({ desktopApi, thread }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.upsertLiveTranscriptEntry({
        type: "message",
        id: "optimistic-user",
        role: "user",
        text: "Show me the latest screenshot.",
        createdAt: 1_000,
        turn: liveTurn,
      });
      result.current.upsertLiveTranscriptEntry({
        type: "message",
        id: "live-commentary",
        role: "assistant",
        phase: "commentary",
        text: "I will fetch the latest capture.",
        createdAt: 1_500,
        turn: liveTurn,
      });
      result.current.upsertLiveTranscriptEntry({
        type: "activity",
        id: "live-tools",
        summary: "Used 1 tool",
        createdAt: 2_000,
        details: [
          {
            id: "tool-1",
            kind: "command",
            label: "Read the latest screenshot",
            status: "completed",
          },
        ],
        turn: liveTurn,
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Show me the latest screenshot.",
      "message:I will fetch the latest capture.",
      "activity:Used 1 tool",
    ]);

    act(() => {
      result.current.setActiveTurnId("turn-1");
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              ...completedTurn,
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Show me the latest screenshot.",
        "message:I will fetch the latest capture.",
        "activity:Used 1 tool",
        "message:Here it is.",
      ]);
    });
  });

  it("does not delete edited file diffs when a later hydration omits them", async () => {
    let now = 40_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const turn = {
      id: "turn-1",
      status: "completed" as const,
      durationMs: 70_000,
    };
    const liveDiff = [
      "diff --git a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "--- a/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "+++ b/apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
      "@@ -113,2 +113,1 @@",
      "-<<<<<<< HEAD",
      "-function appendMessageEntries(",
      "+function messageMatchesOptimisticEntry(",
    ].join("\n");
    const hydratedDiffActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "persisted-diff-1",
      summary: "Edited 1 file, +1, -2",
      createdAt: 1_000,
      details: [
        {
          id: "persisted-diff-detail-1",
          kind: "write",
          label: "Update useThreadSessionState.ts",
          path: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts",
          fileDiff: {
            kind: "update",
            diff: liveDiff,
            additions: 1,
            removals: 2,
          },
        },
      ],
      turn,
    };
    const readThread = vi
      .fn()
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [hydratedDiffActivity],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-final-1",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Rebase completed and checks are green.",
              createdAt: 2_000,
              turn,
            },
          ],
          messages: [
            {
              id: "assistant-final-1",
              role: "assistant" as const,
              text: "Rebase completed and checks are green.",
              createdAt: 2_000,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }));

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.upsertLiveTranscriptEntry({
        ...hydratedDiffActivity,
        id: "live-diff-turn-1",
        createdAt: 1_500,
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Edited 1 file, +1, -2",
    ]);

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "activity:Edited 1 file, +1, -2",
      ]);
    });

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 3_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "activity:Edited 1 file, +1, -2",
        "message:Rebase completed and checks are green.",
      ]);
    });

    const editedActivity = result.current.entries.find(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && entry.summary === "Edited 1 file, +1, -2"
    );
    expect(editedActivity?.details[0]?.fileDiff?.diff).toBe(liveDiff);
  });

  it("only carries forward edited file diffs for the current turn", async () => {
    let now = 50_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const previousTurn = {
      id: "turn-previous",
      status: "completed" as const,
      durationMs: 70_000,
    };
    const currentTurn = {
      id: "turn-current",
      status: "completed" as const,
      durationMs: 80_000,
    };
    const nextTurn = {
      id: "turn-next",
      status: "completed" as const,
      durationMs: 90_000,
    };
    const previousDiff = "diff --git a/old.ts b/old.ts\n--- a/old.ts\n+++ b/old.ts";
    const currentDiff = "diff --git a/current.ts b/current.ts\n--- a/current.ts\n+++ b/current.ts";
    const previousDiffActivity = diffActivity({
      id: "previous-diff",
      summary: "Edited 5 files, +204, -2",
      diff: previousDiff,
      turn: previousTurn,
    });
    const currentDiffActivity = diffActivity({
      id: "current-diff",
      summary: "Edited 6 files, +58, -46",
      diff: currentDiff,
      turn: currentTurn,
    });
    const readThread = vi
      .fn()
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [previousDiffActivity],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-final-current",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Current turn is complete.",
              createdAt: 2_000,
              turn: currentTurn,
            },
          ],
          messages: [
            {
              id: "assistant-final-current",
              role: "assistant" as const,
              text: "Current turn is complete.",
              createdAt: 2_000,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-final-next",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Next turn is complete.",
              createdAt: 3_000,
              turn: nextTurn,
            },
          ],
          messages: [
            {
              id: "assistant-final-next",
              role: "assistant" as const,
              text: "Next turn is complete.",
              createdAt: 3_000,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }));

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "activity:Edited 5 files, +204, -2",
      ]);
    });

    act(() => {
      result.current.upsertLiveTranscriptEntry(currentDiffActivity);
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Edited 5 files, +204, -2",
      "activity:Edited 6 files, +58, -46",
    ]);

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Current turn is complete.",
        "activity:Edited 6 files, +58, -46",
      ]);
    });

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 3_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Next turn is complete.",
      ]);
    });
  });

  it("drops stale completed live work when a newer turn hydrates without it", async () => {
    let now = 80_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    const oldTurn = {
      id: "turn-old",
      status: "completed" as const,
      durationMs: 197_000,
    };
    const newerTurn = {
      id: "turn-newer",
      status: "completed" as const,
      durationMs: 35_000,
    };
    const staleLiveActivity: AppServerThreadActivityEntry = {
      type: "activity",
      id: "live-tools-turn-old",
      summary: "Explored 36 items · Used 3 tools",
      createdAt: 1_500,
      details: [
        {
          id: "old-tool-detail",
          kind: "read",
          label: "Read package.json",
        },
      ],
      turn: oldTurn,
    };
    const readThread = vi
      .fn()
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-final-old",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Old turn is complete.",
              createdAt: 2_000,
              turn: oldTurn,
            },
          ],
          messages: [
            {
              id: "assistant-final-old",
              role: "assistant" as const,
              text: "Old turn is complete.",
              createdAt: 2_000,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "user-newer",
              role: "user" as const,
              text: "We have the latest grammy version right?",
              createdAt: 3_000,
              turn: newerTurn,
            },
            {
              type: "message" as const,
              id: "assistant-final-newer",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Yes. The repo is on the latest published grammy.",
              createdAt: 4_000,
              turn: newerTurn,
            },
          ],
          messages: [
            {
              id: "user-newer",
              role: "user" as const,
              text: "We have the latest grammy version right?",
              createdAt: 3_000,
            },
            {
              id: "assistant-final-newer",
              role: "assistant" as const,
              text: "Yes. The repo is on the latest published grammy.",
              createdAt: 4_000,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }));

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Old turn is complete.",
      ]);
    });

    act(() => {
      result.current.upsertLiveTranscriptEntry(staleLiveActivity);
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Explored 36 items · Used 3 tools",
      "message:Old turn is complete.",
    ]);

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:We have the latest grammy version right?",
        "message:Yes. The repo is on the latest published grammy.",
      ]);
    });
  });

  it("preserves session-owned live activity across thread switches and hydration", async () => {
    let now = 20_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries:
            threadId === "thread-1"
              ? [
                  {
                    type: "message" as const,
                    id: "thread-1-history",
                    role: "assistant" as const,
                    text: "Hydrated response without rich live activity.",
                  },
                ]
              : [],
          messages:
            threadId === "thread-1"
              ? [
                  {
                    id: "thread-1-history",
                    role: "assistant" as const,
                    text: "Hydrated response without rich live activity.",
                  },
                ]
              : [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread1Updated = buildThread({ id: "thread-1", updatedAt: 2_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_500 });
    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: thread1,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "read-1",
              type: "commandExecution",
              command: "sed -n '1,40p' src/one.ts",
              commandActions: [{ type: "read", path: "src/one.ts" }],
            },
          },
        },
      });
    });

    expect(result.current.entries.map((entry) => entry.id)).toEqual([
      "thread-1-history",
      "live-tools-turn-1-1",
    ]);

    rerender({ thread: thread2 });

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-2");
    });

    rerender({ thread: thread1Updated });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "thread-1",
      });
    });
    await waitFor(() => {
      expect(result.current.entries.map((entry) => entry.id)).toEqual([
        "thread-1-history",
        "live-tools-turn-1-1",
      ]);
    });
  });

  it("keeps streamed assistant commentary below the optimistic user prompt", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "history-1",
              role: "assistant" as const,
              text: "Earlier thread context.",
            },
          ],
          messages: [
            {
              id: "history-1",
              role: "assistant" as const,
              text: "Earlier thread context.",
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticUserMessage("Please keep the reply under this prompt.");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "First commentary.",
            phase: "commentary",
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-2",
            delta: "Second commentary.",
            phase: "commentary",
          },
        },
      });
    });

    expect(
      result.current.entries.map((entry) =>
        entry.type === "message" ? `${entry.role}:${entry.text}` : entry.type
      )
    ).toEqual([
      "assistant:Earlier thread context.",
      "user:Please keep the reply under this prompt.",
      "assistant:First commentary.",
    ]);
    expect(result.current.pendingAssistantMessage?.text).toBe("Second commentary.");
  });

  it("hydrates unphased streamed assistant text after completion", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    let readCount = 0;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => {
        readCount += 1;
        return {
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries:
              readCount > 1
                ? [
                    {
                      type: "message" as const,
                      id: "hydrated-final",
                      role: "assistant" as const,
                      phase: "final" as const,
                      text: "Hydrated final answer.",
                      turn: {
                        id: "turn-1",
                        status: "completed" as const,
                      },
                    },
                  ]
                : [],
            messages:
              readCount > 1
                ? [
                    {
                      id: "hydrated-final",
                      role: "assistant" as const,
                      text: "Hydrated final answer.",
                    },
                  ]
                : [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        };
      }
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.replay.entries).toEqual([]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            delta: "Hydrated final answer.",
          },
        },
      });
    });

    expect(result.current.pendingAssistantMessage?.phase).toBeUndefined();

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          id: "hydrated-final",
          phase: "final",
          text: "Hydrated final answer.",
        }),
      ]);
    });
  });

  it("tracks thinking state for a nonselected thread until the turn completes", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-2", updatedAt: 1_500 }),
      })
    );

    await waitFor(() => {
      expect(result.current.response?.threadId).toBe("thread-2");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    await act(async () => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Finished background work." }],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    });
  });

  it("rereads an interacted thread when updatedAt changed on reselect", async () => {
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread1Updated = buildThread({ id: "thread-1", updatedAt: 2_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_500 });

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: thread1,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    expect(readThread).toHaveBeenCalledTimes(1);
    expect(readThread).toHaveBeenNthCalledWith(1, {
      backend: "codex",
      threadId: "thread-1",
    });

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setActiveTurnId(undefined);
    });

    rerender({ thread: thread2 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });

    expect(readThread).toHaveBeenNthCalledWith(2, {
      backend: "codex",
      threadId: "thread-2",
    });

    rerender({ thread: thread1Updated });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });

    expect(readThread).toHaveBeenNthCalledWith(3, {
      backend: "codex",
      threadId: "thread-1",
    });
  });

  it("rereads an interacted thread when the cached transcript is still empty", async () => {
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const updatedThread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread,
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(result.current.entries).toHaveLength(0);

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setActiveTurnId(undefined);
    });

    rerender({ currentThread: updatedThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
  });

  it("rereads an empty transcript after turn completion even when updatedAt is unchanged", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [],
            messages: [],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "hello from launchpad",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "captured after refresh",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread,
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    expect(result.current.entries).toHaveLength(0);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
  });

  it("surfaces a failed transcript read once per thread version", async () => {
    const readThread = vi.fn(async () => {
      throw new Error(
        "json-rpc error (-32603): failed to locate rollout for thread thread-1"
      );
    });

    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const updatedThread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread,
        },
      }
    );

    await waitFor(() => {
      expect(result.current.error).toBe(
        "json-rpc error (-32603): failed to locate rollout for thread thread-1"
      );
    });
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: thread });

    await act(async () => {
      await Promise.resolve();
    });
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: updatedThread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
  });

  it("retries a failed transcript read after the thread is reselected", async () => {
    const thread = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const readThread = vi
      .fn()
      .mockRejectedValueOnce(new Error("Federation peer is not connected"))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [messageEntry({
          createdAt: 1_000,
          id: "recovered-message",
          text: "Remote thread recovered.",
        })],
        hasPreviousPage: false,
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: thread as NavigationThreadSummary | undefined,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.error).toBe("Federation peer is not connected");
    });
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ currentThread: undefined });
    rerender({ currentThread: thread });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.error).toBeUndefined();
      expect(result.current.messages).toEqual([
        expect.objectContaining({
          id: "recovered-message",
          text: "Remote thread recovered.",
        }),
      ]);
    });
  });

  it("keeps thinking visible during metadata notifications for an active turn", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              tokenUsage: {
                modelContextWindow: 258400,
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex",
                planType: "pro",
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              delta: "To github.com:pwrdrvr/PwrAgent.git\n",
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");
  });

  it("stores token usage updates as session-owned transcript entries", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
                reasoning_output_tokens: 10,
              },
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([]);
    expect(result.current.runningTurnUsageText).toBeUndefined();

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Done.",
      "activity:Latest request usage: 1,000 uncached in · 200 cached · 50 out (10 reasoning)",
    ]);
    expect(result.current.entries.at(-1)).toMatchObject({
      id: "live-token-usage-turn-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });
  });

  it("prices token usage with Fast priority rates from thread settings", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          fastMode: true,
          model: "gpt-5.5",
        },
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                inputTokens: 27_697,
                cachedInputTokens: 10_112,
                outputTokens: 95,
              },
            },
          },
        },
      });
    });

    const usageEntry = result.current.entries[0];
    expect(usageEntry?.type).toBe("activity");
    expect(usageEntry?.type === "activity" ? usageEntry.summary : undefined).toBe(
      "Usage: 17,585 uncached in · 10,112 cached · 95 out · $0.24 list price",
    );
    expect(usageEntry?.type === "activity" ? usageEntry.details.at(-1)?.label : undefined).toBe(
      "Cost: $0.24 list price for GPT-5.5 Fast (Priority)",
    );
  });

  it("updates pricing from live pricing notifications without rereading the thread", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const readThread = vi.fn<NonNullable<DesktopApi["readThread"]>>(
      async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        pricing: {
          lines: [],
          summaries: [],
        },
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    expect(result.current.response?.pricing?.summaries).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
                reasoning_output_tokens: 10,
              },
            },
          },
        },
      });
    });
    expect(result.current.response?.pricing?.summaries).toEqual([]);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/pricing/updated",
          params: {
            threadId: "thread-1",
            pricing: {
              lines: [],
              summaries: [
                {
                  backend: "codex",
                  provider: "openai",
                  threadId: "thread-1",
                  currency: "USD",
                  inputTokens: 1_200,
                  uncachedInputTokens: 1_000,
                  cachedInputTokens: 200,
                  outputTokens: 50,
                  reasoningOutputTokens: 10,
                  totalTokens: 1_260,
                  totalCostMicros: 7_250,
                  usageLineCount: 1,
                  pricedUsageLineCount: 1,
                  unpricedUsageLineCount: 0,
                  updatedAt: Date.now(),
                },
              ],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.response?.pricing?.summaries[0]).toMatchObject({
        provider: "openai",
        threadId: "thread-1",
        totalCostMicros: 7_250,
        usageLineCount: 1,
      });
    });
    expect(readThread).toHaveBeenCalledTimes(1);
  });

  it("finalizes active-turn usage from cumulative token deltas", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 1_025,
              },
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 1_025,
              },
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([]);
    expect(result.current.runningTurnUsageText).toBe(
      "Usage so far: 900 uncached in · 100 cached · 20 out (5 reasoning)"
    );

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 2_000,
                cached_input_tokens: 1_800,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 2_040,
              },
              total_token_usage: {
                input_tokens: 3_000,
                cached_input_tokens: 1_900,
                output_tokens: 50,
                reasoning_output_tokens: 15,
                total_tokens: 3_065,
              },
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([]);
    expect(result.current.runningTurnUsageText).toBe(
      "Usage so far: 1,100 uncached in · 1,900 cached · 50 out (15 reasoning)"
    );

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Done.",
      "activity:Turn usage: 1,100 uncached in · 1,900 cached · 50 out (15 reasoning)",
    ]);
    expect(result.current.runningTurnUsageText).toBeUndefined();
    expect(result.current.entries.at(-1)).toMatchObject({
      id: "live-turn-usage-turn-1",
      turn: {
        id: "turn-1",
        status: "completed",
      },
    });

    act(() => {
      result.current.setActiveTurnId("turn-2");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 2_000,
                cached_input_tokens: 1_800,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 2_040,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Done.",
      "activity:Turn usage: 1,100 uncached in · 1,900 cached · 50 out (15 reasoning)",
    ]);
    expect(result.current.runningTurnUsageText).toBeUndefined();
  });

  it("consolidates trailing request usage into one authoritative turn-end row", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        pricing: {
          lines: [],
          summaries: [],
        },
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          model: "gpt-5.6-sol",
        },
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 25_027_409,
                cached_input_tokens: 24_434_560,
                output_tokens: 66_248,
                reasoning_output_tokens: 23_974,
                total_tokens: 25_117_631,
              },
              total_token_usage: {
                input_tokens: 25_027_409,
                cached_input_tokens: 24_434_560,
                output_tokens: 66_248,
                reasoning_output_tokens: 23_974,
                total_tokens: 25_117_631,
              },
            },
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              startedAt: 1_000,
              completedAt: 1_800_000_004_000,
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });
    act(() => {
      result.current.upsertLiveTranscriptEntry({
        type: "activity",
        id: "late-final-checks",
        createdAt: 3_500,
        summary: "Ran final checks",
        status: "completed",
        details: [],
        turn: {
          id: "turn-1",
          status: "completed",
          startedAt: 1_000,
          completedAt: 1_800_000_004_000,
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 112_017,
                cached_input_tokens: 111_232,
                output_tokens: 319,
                reasoning_output_tokens: 90,
                total_tokens: 112_426,
              },
            },
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 112_017,
                cached_input_tokens: 111_232,
                output_tokens: 319,
                reasoning_output_tokens: 90,
                total_tokens: 112_426,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Ran final checks",
      "message:Done.",
      "activity:Turn usage: 593,634 uncached in · 24,545,792 cached · 66,567 out (24,064 reasoning) · $14.01 list price",
    ]);
    expect(result.current.entries.at(-1)).toMatchObject({
      id: "live-turn-usage-turn-1",
      createdAt: 1_800_000_004_000,
      turn: {
        id: "turn-1",
        status: "completed",
        completedAt: 1_800_000_004_000,
      },
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/pricing/updated",
          params: {
            threadId: "thread-1",
            pricing: {
              lines: [{
                ...authoritativeTurnUsageLine(),
                completedAt: 1_800_000_004_000,
              }],
              summaries: [],
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Ran final checks",
      "message:Done.",
      "activity:Turn usage: 593,634 uncached in · 24,545,792 cached · 66,567 out (24,064 reasoning) · $14.01 list price",
    ]);
    expect(result.current.entries.at(-1)).toMatchObject({
      id: "live-turn-usage-turn-1",
      createdAt: 1_800_000_004_000,
      turn: {
        id: "turn-1",
        status: "completed",
        completedAt: 1_800_000_004_000,
      },
      usageLine: {
        usageLineId: "codex:thread-1:turn-1:live-token-usage",
        totalCostMicros: 14_005_473,
      },
    });
    const usageEntry = result.current.entries.at(-1);
    expect(usageEntry?.type === "activity" ? usageEntry.details : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label:
            "Input: 25,139,426 tokens (593,634 uncached, 24,545,792 cached)",
        }),
        expect.objectContaining({
          label: "Output: 66,567 tokens, including 24,064 reasoning",
        }),
        expect.objectContaining({
          label: expect.stringContaining("Cost: $14.01 list price"),
        }),
      ]),
    );
  });

  it("reconciles hydrated usage snapshots at the completed turn boundary", async () => {
    const turn = {
      id: "turn-1",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 4_000,
    };
    const response = readThreadResponse({
      entries: [
        {
          type: "activity",
          id: "live-token-usage-turn-1",
          createdAt: 1_000,
          summary:
            "Latest request usage: 785 uncached in · 111,232 cached · 319 out (90 reasoning) · $0.056 list price",
          status: "completed",
          details: [],
          turn,
        },
        {
          type: "activity",
          id: "late-final-checks",
          createdAt: 3_500,
          summary: "Ran final checks",
          status: "completed",
          details: [],
          turn,
        },
        {
          type: "message",
          id: "assistant-turn-1",
          role: "assistant",
          phase: "final",
          text: "Done.",
          createdAt: 4_000,
          turn,
        },
        {
          type: "activity",
          id: "live-turn-usage-turn-1",
          createdAt: 3_900,
          summary:
            "Turn usage: 592,849 uncached in · 24,434,560 cached · 66,248 out (23,974 reasoning) · $13.95 list price",
          status: "completed",
          details: [],
          turn,
        },
      ],
      hasPreviousPage: false,
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: async () => ({
        ...response,
        pricing: {
          lines: [authoritativeTurnUsageLine()],
          summaries: [],
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Ran final checks",
      "message:Done.",
      "activity:Turn usage: 593,634 uncached in · 24,545,792 cached · 66,567 out (24,064 reasoning) · $14.01 list price",
    ]);
    expect(result.current.entries.at(-1)).toMatchObject({
      id: "live-turn-usage-turn-1",
      createdAt: 4_000,
      usageLine: {
        usageLineId: "codex:thread-1:turn-1:live-token-usage",
      },
    });
  });

  it("reconciles completed usage inside an older history page", async () => {
    const turn = {
      id: "turn-1",
      status: "completed" as const,
      startedAt: 1_000,
      completedAt: 4_000,
    };
    const initialTail = readThreadResponse({
      entries: [messageEntry({
        id: "newer-message",
        role: "user",
        text: "Next prompt",
        createdAt: 5_000,
      })],
      hasPreviousPage: true,
      previousCursor: "newer-message",
    });
    const olderPage = {
      ...readThreadResponse({
        entries: [
          {
            type: "activity" as const,
            id: "late-final-checks",
            createdAt: 3_500,
            summary: "Ran final checks",
            status: "completed" as const,
            details: [],
            turn,
          },
          {
            type: "message" as const,
            id: "assistant-turn-1",
            role: "assistant" as const,
            phase: "final" as const,
            text: "Done.",
            createdAt: 4_000,
            turn,
          },
          {
            type: "activity" as const,
            id: "live-turn-usage-turn-1",
            createdAt: 3_900,
            summary:
              "Turn usage: 592,849 uncached in · 24,434,560 cached · 66,248 out (23,974 reasoning) · $13.95 list price",
            status: "completed" as const,
            details: [],
            turn,
          },
          {
            type: "activity" as const,
            id: "live-token-usage-turn-1",
            createdAt: 3_950,
            summary:
              "Latest request usage: 785 uncached in · 111,232 cached · 319 out (90 reasoning) · $0.056 list price",
            status: "completed" as const,
            details: [],
            turn,
          },
        ],
        hasPreviousPage: false,
      }),
      pricing: {
        lines: [authoritativeTurnUsageLine()],
        summaries: [],
      },
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(initialTail)
      .mockResolvedValueOnce(olderPage);
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        initialHistoryLimit: DEFAULT_INITIAL_THREAD_HISTORY_TURN_LIMIT,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);
    await act(async () => {
      await result.current.loadOlder();
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:Ran final checks",
      "message:Done.",
      "activity:Turn usage: 593,634 uncached in · 24,545,792 cached · 66,567 out (24,064 reasoning) · $14.01 list price",
      "message:Next prompt",
    ]);
    expect(result.current.entries[2]).toMatchObject({
      id: "live-turn-usage-turn-1",
      createdAt: 4_000,
    });
  });

  it("prices finalized active-turn usage from the token usage notification model", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            model: "gpt-5.4",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_217_026,
                cached_input_tokens: 1_120_384,
                output_tokens: 3_721,
                reasoning_output_tokens: 1_130,
              },
              total_token_usage: {
                input_tokens: 1_217_026,
                cached_input_tokens: 1_120_384,
                output_tokens: 3_721,
                reasoning_output_tokens: 1_130,
              },
            },
          },
        },
      });
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Done.",
      "activity:Turn usage: 96,642 uncached in · 1,120,384 cached · 3,721 out (1,130 reasoning) · $0.60 list price",
    ]);
  });

  it("keeps aggregate turn usage when hydration includes per-request usage", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    let readCount = 0;
    const readThread = vi.fn(async ({ backend, threadId }) => {
      readCount += 1;
      const hydratedCompletedTurn = readCount > 1;
      return {
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: hydratedCompletedTurn
            ? [
                {
                  type: "message" as const,
                  id: "assistant-turn-1",
                  role: "assistant" as const,
                  phase: "final" as const,
                  text: "Done.",
                  createdAt: 10_000,
                  turn: {
                    id: "turn-1",
                    status: "completed" as const,
                  },
                },
                {
                  type: "activity" as const,
                  id: "command-turn-1",
                  summary: "Ran shell command",
                  status: "completed" as const,
                  createdAt: 10_001,
                  turn: {
                    id: "turn-1",
                    status: "completed" as const,
                  },
                  details: [
                    {
                      id: "command-turn-1-detail",
                      kind: "read" as const,
                      label: "npm test",
                      status: "completed" as const,
                    },
                  ],
                },
                {
                  type: "activity" as const,
                  id: "live-token-usage-turn-1",
                  summary: "Latest request usage: 200 uncached in · 1,800 cached · 30 out (10 reasoning)",
                  status: "completed" as const,
                  createdAt: 10_002,
                  turn: {
                    id: "turn-1",
                    status: "completed" as const,
                  },
                  details: [
                    {
                      id: "live-token-usage-turn-1-input",
                      kind: "read" as const,
                      label: "Input: 2,000 tokens (200 uncached, 1,800 cached)",
                      status: "completed" as const,
                    },
                    {
                      id: "live-token-usage-turn-1-output",
                      kind: "read" as const,
                      label: "Output: 30 tokens, including 10 reasoning",
                      status: "completed" as const,
                    },
                  ],
                },
              ]
            : [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      };
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 1_025,
              },
              total_token_usage: {
                input_tokens: 1_000,
                cached_input_tokens: 100,
                output_tokens: 20,
                reasoning_output_tokens: 5,
                total_tokens: 1_025,
              },
            },
          },
        },
      });
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 2_000,
                cached_input_tokens: 1_800,
                output_tokens: 30,
                reasoning_output_tokens: 10,
                total_tokens: 2_040,
              },
              total_token_usage: {
                input_tokens: 3_000,
                cached_input_tokens: 1_900,
                output_tokens: 50,
                reasoning_output_tokens: 15,
                total_tokens: 3_065,
              },
            },
          },
        },
      });
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Done.",
        "activity:Ran shell command",
        "activity:Turn usage: 1,100 uncached in · 1,900 cached · 50 out (15 reasoning)",
      ]);
    });
  });

  it("does not rewrite completed turn usage from later same-id updates", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    let readCount = 0;
    const readThread = vi.fn(async ({ backend, threadId }) => {
      readCount += 1;
      return {
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries:
            readCount > 1
              ? [
                  {
                    type: "activity" as const,
                    id: "live-token-usage-turn-1",
                    summary:
                      "Latest request usage: 1,715 uncached in · 18,285 cached · 90 out (30 reasoning)",
                    status: "completed" as const,
                    createdAt: 20_000,
                    turn: {
                      id: "turn-1",
                      status: "completed" as const,
                    },
                    details: [
                      {
                        id: "live-token-usage-turn-1-input",
                        kind: "read" as const,
                        label: "Input: 20,000 tokens (1,715 uncached, 18,285 cached)",
                        status: "completed" as const,
                      },
                    ],
                  },
                ]
              : [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      };
    });
    const persistThreadUsageActivity = vi.fn(async ({ backend, threadId, activity }) => ({
      backend,
      threadId,
      activityId: activity.id,
      persisted: true,
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      persistThreadUsageActivity,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: { ...buildThread({ id: "thread-1", updatedAt: 1_000 }), model: "gpt-5.5" },
        },
      }
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 43_000,
                cached_input_tokens: 20_000,
                output_tokens: 900,
                reasoning_output_tokens: 450,
                total_tokens: 44_350,
              },
            },
          },
        },
      });
    });

    const originalSummary = result.current.entries[0]?.type === "activity"
      ? result.current.entries[0].summary
      : undefined;
    expect(originalSummary).toContain("23,000 uncached in");
    expect(originalSummary).toContain("20,000 cached");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 20_000,
                cached_input_tokens: 18_285,
                output_tokens: 90,
                reasoning_output_tokens: 30,
                total_tokens: 20_120,
              },
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      `activity:${originalSummary}`,
    ]);

    rerender({
      thread: { ...buildThread({ id: "thread-1", updatedAt: 2_000 }), model: "gpt-5.5" },
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        `activity:${originalSummary}`,
      ]);
    });
    expect(persistThreadUsageActivity).not.toHaveBeenCalled();
  });

  it("does not persist pending usage for an unrelated delayed completion", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const persistThreadUsageActivity = vi.fn(async ({ backend, threadId, activity }) => ({
      backend,
      threadId,
      activityId: activity.id,
      persisted: true,
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      persistThreadUsageActivity,
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-2");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-2",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
                total_tokens: 1_250,
              },
              total_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
                total_tokens: 1_250,
              },
            },
          },
        },
      });
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Older turn done." }],
            },
          },
        },
      });
    });

    expect(persistThreadUsageActivity).not.toHaveBeenCalled();
    expect(result.current.runningTurnUsageText).toBe(
      "Usage so far: 1,000 uncached in · 200 cached · 50 out",
    );
  });

  it("uses known turn timing for older turn usage while a newer turn is active", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const persistThreadUsageActivity = vi.fn(async ({ backend, threadId, activity }) => ({
      backend,
      threadId,
      activityId: activity.id,
      persisted: true,
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      persistThreadUsageActivity,
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: "assistant-turn-old",
              role: "assistant" as const,
              phase: "final" as const,
              text: "Older assistant answer.",
              createdAt: 1_781_630_430_000,
              turn: {
                id: "turn-old",
                status: "completed" as const,
                startedAt: 1_781_630_372_000,
                completedAt: 1_781_630_444_000,
                durationMs: 10_000,
              },
            },
            {
              type: "activity" as const,
              id: "live-turn-usage-turn-old",
              createdAt: 1_781_630_444_000,
              details: [],
              status: "completed" as const,
              summary: "Turn usage: 9,000 uncached in · 1,000 cached · 100 out",
              turn: {
                id: "turn-old",
                status: "completed" as const,
                startedAt: 1_781_630_372_000,
                completedAt: 1_781_630_444_000,
                durationMs: 10_000,
              },
            },
          ],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-new");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-old",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 10_000,
                cached_input_tokens: 9_000,
                output_tokens: 100,
                reasoning_output_tokens: 20,
                total_tokens: 10_120,
              },
              total_token_usage: {
                input_tokens: 200_000,
                cached_input_tokens: 180_000,
                output_tokens: 1_000,
                reasoning_output_tokens: 200,
                total_tokens: 201_200,
              },
              model_context_window: 258_400,
            },
          },
        },
      });
    });

    expect(persistThreadUsageActivity).toHaveBeenCalledTimes(1);
    expect(persistThreadUsageActivity).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      activity: expect.objectContaining({
        id: "live-turn-usage-turn-old",
        createdAt: 1_781_630_444_000,
        turn: expect.objectContaining({
          id: "turn-old",
          status: "completed",
          startedAt: 1_781_630_372_000,
          completedAt: 1_781_630_444_000,
          durationMs: 10_000,
        }),
      }),
    });
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Older assistant answer.",
      "activity:Turn usage: 1,000 uncached in · 9,000 cached · 100 out (20 reasoning)",
    ]);
    expect(result.current.runningTurnUsageText).toBeUndefined();
    expect(result.current.contextWindow).toMatchObject({
      cachedInputTokens: 9_000,
      cumulativeCachedInputTokens: 180_000,
      cumulativeInputTokens: 200_000,
      cumulativeOutputTokens: 1_000,
      cumulativeReasoningOutputTokens: 200,
      inputTokens: 10_000,
      modelContextWindow: 258_400,
      outputTokens: 100,
      totalTokens: 10_120,
    });
  });

  it("keeps completed token usage before the next turn user prompt during hydration", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    let readCount = 0;
    const readThread = vi.fn(async ({ backend, threadId }) => {
      readCount += 1;
      const secondHydration = readCount > 1;
      return {
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: secondHydration
            ? [
                {
                  type: "message" as const,
                  id: "assistant-turn-1",
                  role: "assistant" as const,
                  phase: "final" as const,
                  text: "Done.",
                  createdAt: 10_000,
                },
                {
                  type: "message" as const,
                  id: "user-turn-2",
                  role: "user" as const,
                  text: "Take another look",
                  createdAt: 20_000,
                },
              ]
            : [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      };
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          thread,
        }),
      {
        initialProps: {
          thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
              },
            },
          },
        },
      });
    });
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            turn: {
              id: "turn-1",
              status: "completed",
              output: [{ type: "text", text: "Done." }],
            },
          },
        },
      });
    });

    rerender({ thread: buildThread({ id: "thread-1", updatedAt: 2_000 }) });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(transcriptLabels(result.current.entries)).toEqual([
        "message:Done.",
        "activity:Latest request usage: 1,000 uncached in · 200 cached · 50 out",
        "message:Take another look",
      ]);
    });
  });

  it("derives the transcript thinking status from an active turn when status text is cleared", async () => {
    const desktopApi: DesktopApi = {
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setPendingStatusText("Thinking");
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText(undefined);
    });

    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);
  });

  it("keeps thinking visible when an idle status arrives before turn completion", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-1",
              status: {
                type: "idle",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.activeTurnId).toBeUndefined();
  });

  it("rechecks a selected thinking thread when idle has no terminal event", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [],
        hasPreviousPage: false,
        threadStatus: "active",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [],
        hasPreviousPage: false,
        threadStatus: "idle",
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          threadStatus: "active" as const,
        },
      })
    );

    await waitForThreadHydration(result);
    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });

    vi.useFakeTimers();
    try {
      act(() => {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-1",
              status: { type: "idle" },
            },
          },
        });
      });

      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(1_501);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(readThread).toHaveBeenCalledTimes(2);
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears renderer-owned thinking for an unfocused thread that remains idle", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let threadOneReadCount = 0;
    const readThread = vi.fn(async ({ threadId }) => {
      const isDurableCompletion =
        threadId === "thread-1" && ++threadOneReadCount === 2;
      return readThreadResponse({
        entries: isDurableCompletion
          ? [
              {
                ...messageEntry({
                  createdAt: 3_000,
                  id: "assistant-final",
                  text: "Durable final response.",
                }),
                phase: "final" as const,
                turn: {
                  id: "turn-1",
                  status: "completed" as const,
                },
              },
            ]
          : [],
        hasPreviousPage: false,
        threadId,
        threadStatus: "idle",
      });
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitForThreadHydration(result);
    act(() => {
      result.current.setActiveTurnId("turn-1");
      result.current.setPendingStatusText("Thinking");
    });
    rerender({
      currentThread: buildThread({ id: "thread-2", updatedAt: 2_000 }),
    });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });

    vi.useFakeTimers();
    try {
      act(() => {
        agentEventHandler?.({
          backend: "codex",
          notification: {
            method: "thread/status/changed",
            params: {
              threadId: "thread-1",
              status: { type: "idle" },
            },
          },
        });
      });

      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1_501);
      });

      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
      expect(readThread).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }

    rerender({
      currentThread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
    });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
      expect(result.current.messages.map((message) => message.text)).toContain(
        "Durable final response."
      );
    });
  });

  it("shows a transcript status when context compaction starts", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "compact-turn-1",
              item: {
                id: "compact-item-1",
                type: "contextCompaction",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Compacting context");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/compacted",
            params: {
              threadId: "thread-1",
              itemId: "compact-item-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.contextWindow).toBeUndefined();
  });

  it("ignores live transcript activity for unrelated threads", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        liveTranscriptEventFiltering: true,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    const commandItem = {
      id: "tool-2",
      type: "commandExecution",
      command: "pnpm test",
      status: "inProgress",
    };

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-2",
              turnId: "turn-2",
              item: commandItem,
            },
          },
        });
      }
    });

    expect(result.current.entries).toEqual([]);
    expect(result.current.thinkingThreadKeys["codex:thread-2"]).toBeUndefined();
  });

  it("keeps unrelated live transcript activity when filtering is disabled", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    const commandItem = {
      id: "tool-2",
      type: "commandExecution",
      command: "pnpm test",
      status: "inProgress",
    };

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-2",
              turnId: "turn-2",
              item: commandItem,
            },
          },
        });
      }
    });

    expect(result.current.thinkingThreadKeys["codex:thread-2"]).toBe(true);
  });

  it("clears unrelated completed turn state without appending transcript output when filtering is enabled", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-assistant`,
              role: "assistant" as const,
              text: `Hydrated transcript for ${threadId}.`,
            },
          ],
          messages: [
            {
              id: `${threadId}-assistant`,
              role: "assistant" as const,
              text: `Hydrated transcript for ${threadId}.`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_000 });
    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          liveTranscriptEventFiltering: true,
          thread,
        }),
      {
        initialProps: {
          thread: thread1,
        },
      },
    );

    await waitForThreadHydration(result, "thread-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-2",
              turnId: "turn-2",
              turn: {
                id: "turn-2",
                status: "in_progress",
              },
            },
          },
        });
      }
    });

    expect(result.current.thinkingThreadKeys["codex:thread-2"]).toBe(true);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-2",
              turnId: "turn-2",
              turn: {
                id: "turn-2",
                status: "completed",
                output: [{ type: "text", text: "Background final answer." }],
              },
            },
          },
        });
      }
    });

    expect(result.current.thinkingThreadKeys["codex:thread-2"]).toBeUndefined();

    rerender({ thread: thread2 });

    await waitForThreadHydration(result, "thread-2");
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(transcriptLabels(result.current.entries)).toEqual([
      "message:Hydrated transcript for thread-2.",
    ]);
  });

  it("keeps non-focused compaction invalidations for cached threads", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-assistant`,
              role: "assistant" as const,
              text: `Cached transcript for ${threadId}.`,
            },
          ],
          messages: [
            {
              id: `${threadId}-assistant`,
              role: "assistant" as const,
              text: `Cached transcript for ${threadId}.`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread1 = buildThread({ id: "thread-1", updatedAt: 1_000 });
    const thread2 = buildThread({ id: "thread-2", updatedAt: 1_000 });
    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadSessionState({
          desktopApi,
          liveTranscriptEventFiltering: true,
          thread,
        }),
      {
        initialProps: {
          thread: thread2,
        },
      }
    );

    await waitForThreadHydration(result, "thread-2");
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ thread: thread1 });
    await waitForThreadHydration(result, "thread-1");
    expect(readThread).toHaveBeenCalledTimes(2);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "thread/compacted",
            params: {
              threadId: "thread-2",
              itemId: "compact-item-2",
            },
          },
        });
      }
    });

    rerender({ thread: thread2 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(3);
    });
    await waitForThreadHydration(result, "thread-2");
  });

  it("keeps repeated identical live activity updates as renderer no-ops", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useThreadSessionState({
        desktopApi,
        liveTranscriptEventFiltering: true,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      });
    });

    await waitForThreadHydration(result);

    const event = {
      backend: "codex" as const,
      notification: {
        method: "item/started" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            command: "pnpm test",
            status: "inProgress",
          },
        },
      },
    };

    act(() => {
      for (const listener of agentEventListeners) {
        listener(event);
      }
    });

    expect(transcriptLabels(result.current.entries)).toEqual(["activity:pnpm test"]);
    await flushReactUpdates();
    const rendersAfterFirstUpdate = renderCount;

    act(() => {
      for (const listener of agentEventListeners) {
        listener(event);
      }
    });

    expect(transcriptLabels(result.current.entries)).toEqual(["activity:pnpm test"]);
    expect(renderCount).toBe(rendersAfterFirstUpdate);
  });

  it("handles repeated identical live activity updates when filtering is disabled", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      });
    });

    await waitForThreadHydration(result);

    const event = {
      backend: "codex" as const,
      notification: {
        method: "item/started" as const,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "tool-1",
            type: "commandExecution",
            command: "pnpm test",
            status: "inProgress",
          },
        },
      },
    };

    act(() => {
      for (const listener of agentEventListeners) {
        listener(event);
      }
    });

    expect(transcriptLabels(result.current.entries)).toEqual(["activity:pnpm test"]);
    await flushReactUpdates();
    const rendersAfterFirstUpdate = renderCount;

    act(() => {
      for (const listener of agentEventListeners) {
        listener(event);
      }
    });

    expect(transcriptLabels(result.current.entries)).toEqual(["activity:pnpm test"]);
    expect(renderCount).toBeGreaterThan(rendersAfterFirstUpdate);
  });

  it("returns to thinking when context compaction completes and the turn continues", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "in_progress",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "compact-item-1",
                type: "contextCompaction",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Compacting context");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "compact-item-1",
                type: "contextCompaction",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);
  });

  it("clears thinking state on a failed turn without stashing a transient error", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "in_progress",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Thinking");
    expect(result.current.activeTurnId).toBe("turn-1");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/failed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "failed",
                error: {
                  message: "Provider completed the turn without assistant text.",
                },
              },
            },
          },
        });
      }
    });

    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
    // The failure is no longer stashed in transient session.error — that
    // line flashed then got wiped by the next readThread reconciliation.
    // It's now surfaced durably via the overlay turnFailureLog (rendered as
    // a `turn-failed:` transcript entry) and a sticky toast, so this hook
    // intentionally leaves `error` unset on turn/failed.
    expect(result.current.error).toBeUndefined();
  });

  it("surfaces command execution approval requests from app-server events", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/commandExecution/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              requestId: "approval-1",
              reason: "Network access is required.",
              command: "npm view dive",
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for approval");
    expect(result.current.approvalRequestThreadKeys).toEqual({
      "codex:thread-1": true,
    });
    expect(result.current.pendingRequest).toMatchObject({
      method: "item/commandExecution/requestApproval",
      params: {
        requestId: "approval-1",
        command: "npm view dive",
      },
    });
  });

  it("does not surface permissions approvals as command approval requests", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/permissions/requestApproval",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "call-1",
              requestId: "approval-1",
              reason: "Additional permissions are required.",
              permissions: {
                type: "full-access",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.pendingRequest).toBeUndefined();
  });

  it("surfaces request_user_input as pending user input instead of approval", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "input-1",
              requestId: "input-request-1",
              questions: [
                {
                  id: "approach",
                  header: "Approach",
                  question: "Which path should I take?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    {
                      label: "Small patch (Recommended)",
                      description: "Keep this scoped.",
                    },
                    {
                      label: "Large refactor",
                      description: "Touch adjacent flows.",
                    },
                  ],
                },
              ],
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for input");
    expect(result.current.inputRequestThreadKeys).toEqual({
      "codex:thread-1": true,
    });
    expect(result.current.approvalRequestThreadKeys).toEqual({});
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toMatchObject({
      method: "item/tool/requestUserInput",
      requestId: "input-request-1",
      questions: [
        {
          id: "approach",
          options: [
            {
              key: "A",
              label: "Small patch (Recommended)",
              recommended: true,
            },
            {
              key: "B",
              label: "Large refactor",
              recommended: false,
            },
          ],
        },
      ],
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "input-request-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.inputRequestThreadKeys).toEqual({});
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("recovers pending user input from thread hydration after a renderer restart", async () => {
    const pendingRequest: AppServerToolRequestUserInputNotification = {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-1",
        requestId: "input-request-1",
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Which path should I take?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Small patch (Recommended)",
                description: "Keep this scoped.",
              },
            ],
          },
        ],
      },
    };
    const desktopApi: DesktopApi = {
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        pendingRequest,
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.pendingStatusText).toBe("Waiting for input");
    expect(result.current.inputRequestThreadKeys).toEqual({
      "codex:thread-1": true,
    });
    expect(result.current.pendingUserInput).toMatchObject({
      requestId: "input-request-1",
      questions: [{ id: "approach" }],
    });
  });

  it("does not reintroduce thinking when a request resolves after turn completion", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/tool/requestUserInput",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "input-1",
              requestId: "input-request-1",
              questions: [
                {
                  id: "approach",
                  header: "Approach",
                  question: "Which path should I take?",
                  isOther: false,
                  isSecret: false,
                  options: [
                    {
                      label: "Small patch (Recommended)",
                      description: "Keep this scoped.",
                    },
                  ],
                },
              ],
            },
          },
        });
      }
    });

    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.pendingStatusText).toBe("Waiting for input");

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "input-request-1",
            },
          },
        });
      }
    });

    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
  });

  it("surfaces MCP elicitations as pending MCP interactions instead of approval", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              requestId: "mcp-request-1",
              serverName: "playwright",
              mode: "form",
              _meta: {
                tool_description: "List, create, close, or select a browser tab.",
              },
              message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
              requestedSchema: {
                type: "object",
                properties: {},
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingStatusText).toBe("Waiting for MCP approval");
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingMcpInteraction).toMatchObject({
      method: "mcpServer/elicitation/request",
      requestId: "mcp-request-1",
      serverName: "playwright",
      mode: "form",
      form: {
        empty: true,
        fields: [],
      },
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "mcp-request-1",
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("clears pending MCP interactions when the turn is cancelled", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              requestId: "mcp-request-cancelled",
              serverName: "playwright",
              mode: "form",
              _meta: null,
              message: "Allow the playwright MCP server to run tool \"browser_tabs\"?",
              requestedSchema: {
                type: "object",
                properties: {},
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction?.requestId).toBe(
      "mcp-request-cancelled"
    );

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/cancelled",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "cancelled",
              },
            },
          },
        });
      }
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingRequest).toBeUndefined();
    expect(result.current.pendingUserInput).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
  });

  it("updates and clears pending MCP interactions", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "mcpServer/elicitation/request",
            params: {
              threadId: "thread-1",
              turnId: null,
              requestId: "mcp-request-2",
              serverName: "github",
              mode: "form",
              _meta: null,
              message: "Provide a repository.",
              requestedSchema: {
                type: "object",
                required: ["repo"],
                properties: {
                  repo: {
                    type: "string",
                    title: "Repository",
                  },
                },
              },
            },
          },
        });
      }
    });

    act(() => {
      result.current.updatePendingMcpInteraction("mcp-request-2", (state) => ({
        ...state,
        form: state.form
          ? {
              ...state.form,
              fields: state.form.fields.map((field) =>
                field.key === "repo" && field.kind === "string"
                  ? { ...field, value: "pwrdrvr/PwrAgent" }
                  : field
              ),
            }
          : state.form,
      }));
    });

    expect(result.current.pendingMcpInteraction?.form?.fields[0]).toMatchObject({
      key: "repo",
      value: "pwrdrvr/PwrAgent",
    });

    act(() => {
      result.current.clearPendingRequest("mcp-request-2", "Thinking");
    });

    expect(result.current.pendingMcpInteraction).toBeUndefined();
    expect(result.current.pendingStatusText).toBe("Thinking");
  });

  it("rereads a partially hydrated transcript after turn completion when only the user message is present", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi
      .fn()
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
            ],
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      )
      .mockImplementationOnce(
        async ({
          backend,
          threadId,
        }: {
          backend?: AppServerBackendKind;
          threadId: string;
        }) => ({
          backend: backend ?? "codex",
          fetchedAt: Date.now(),
          threadId,
          replay: {
            entries: [
              {
                type: "message" as const,
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
              {
                type: "message" as const,
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "The new thread is live and the reply has been hydrated.",
              },
            ],
            messages: [
              {
                id: `${threadId}-message-1`,
                role: "user" as const,
                text: "Let's test creating a new thread again",
              },
              {
                id: `${threadId}-message-2`,
                role: "assistant" as const,
                text: "The new thread is live and the reply has been hydrated.",
              },
            ],
            lastAssistantMessage: "The new thread is live and the reply has been hydrated.",
            pagination: {
              supportsPagination: false,
              hasPreviousPage: false,
            },
          },
        })
      );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const thread = buildThread({ id: "thread-1", updatedAt: 2_000 });

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread,
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toHaveLength(2);
    });
    expect(result.current.entries[1]).toMatchObject({
      role: "assistant",
      text: "The new thread is live and the reply has been hydrated.",
    });
  });

  it("renders live review items without synthesizing an assistant completion message", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const readThread = vi.fn(
      async ({
        backend,
        threadId,
      }: {
        backend?: AppServerBackendKind;
        threadId: string;
      }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "message" as const,
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          messages: [
            {
              id: `${threadId}-message-1`,
              role: "assistant" as const,
              text: `Loaded ${threadId}`,
            },
          ],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })
    );

    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });

    act(() => {
      result.current.addOptimisticReviewEntry("Review changes against main");
    });

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              item: {
                id: "turn-review-1-item-entered",
                type: "enteredReviewMode",
                review: "changes against 'main'",
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              item: {
                id: "turn-review-1-item",
                type: "exitedReviewMode",
                review: "No findings. Ready to merge.",
                data: {
                  reviewer: {
                    backend: "codex",
                    model: "gpt-5.6-sol",
                    reasoningEffort: "high",
                  },
                  reviewOutput: {
                    findings: [],
                    overall_correctness: "patch is correct",
                    overall_explanation: "No findings. Ready to merge.",
                    overall_confidence_score: 0.92,
                  },
                },
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              itemId: "turn-review-1-assistant",
              delta: "No findings. Ready to merge.",
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-review-1",
              turn: {
                id: "turn-review-1",
                status: "completed",
                output: [{ type: "text", text: "No findings. Ready to merge." }],
              },
            },
          },
        });
      }
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "message" ? `${entry.role}:${entry.text}` : `${entry.type}:${entry.id}`
        )
      ).toEqual([
        "assistant:Loaded thread-1",
        "review:turn-review-1-item-entered",
        "review:turn-review-1-item",
      ]);
      expect(result.current.entries[1]).toMatchObject({
        type: "review",
        review: "Review changes against main",
        displayText: "Review changes against main",
      });
      expect(result.current.entries[2]).toMatchObject({
        type: "review",
        reviewer: {
          backend: "codex",
          model: "gpt-5.6-sol",
          reasoningEffort: "high",
        },
      });
    });
    expect(result.current.response?.replay.messages).toHaveLength(1);
    expect(result.current.messages).toEqual([
      expect.objectContaining({
        role: "assistant",
        text: "Loaded thread-1",
      }),
    ]);
  });

  it("keeps the review start marker when only the final review item arrives live", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventHandler = listener;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    const finalReviewCreatedAt = Date.now() + 1_000;
    act(() => {
      result.current.addOptimisticReviewEntry("Review changes against main");
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review-1",
            item: {
              id: "turn-review-1-item",
              type: "exitedReviewMode",
              review: "No findings. Ready to merge.",
              createdAt: finalReviewCreatedAt,
              data: {
                reviewOutput: {
                  findings: [],
                  overall_correctness: "patch is correct",
                  overall_explanation: "No findings. Ready to merge.",
                  overall_confidence_score: 0.92,
                },
              },
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(
        result.current.entries.map((entry) =>
          entry.type === "review" ? entry.review : entry.type
        )
      ).toEqual([
        "Review changes against main",
        "No findings. Ready to merge.",
      ]);
    });
    expect(result.current.entries[1]).toMatchObject({
      type: "review",
      id: "turn-review-1-item",
      createdAt: finalReviewCreatedAt,
    });
  });

  it("carries the review's frozen workspace and pull request onto the entry", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventHandler = listener;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review-2",
            item: {
              id: "turn-review-2-item",
              type: "exitedReviewMode",
              review: "One finding.",
              data: {
                reviewer: { backend: "codex", model: "gpt-5.6-sol" },
                // The registry freezes this onto the live item beside
                // `reviewer`; dropping it here is what once made the
                // provenance row invisible on the native review path.
                context: {
                  workspacePath: "/Users/dev/pwrdrvr/PwrAgent",
                  projectLabel: "PwrAgent",
                  gitBranch: "fix/dock-icon",
                  baseBranch: "origin/main",
                  pullRequest: {
                    provider: "github.com",
                    org: "pwrdrvr",
                    repo: "PwrAgent",
                    number: 1918,
                    baseRefName: "main",
                    url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
                  },
                },
              },
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });
    expect(result.current.entries[0]).toMatchObject({
      type: "review",
      context: {
        workspacePath: "/Users/dev/pwrdrvr/PwrAgent",
        projectLabel: "PwrAgent",
        gitBranch: "fix/dock-icon",
        baseBranch: "origin/main",
        pullRequest: {
          number: 1918,
          baseRefName: "main",
        },
      },
      reviewer: { backend: "codex", model: "gpt-5.6-sol" },
    });
  });

  it.each([
    ["semantic review match", "review-start-live"],
    ["exact item-ID replacement", "review-start"],
  ])("does not drop replay provenance during a %s", async (_case, liveItemId) => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const context = {
      workspacePath: "/Users/dev/pwrdrvr/PwrAgent",
      projectLabel: "PwrAgent",
      gitBranch: "fix/dock-icon",
      baseBranch: "origin/main",
      pullRequest: {
        provider: "github.com",
        org: "pwrdrvr",
        repo: "PwrAgent",
        number: 1918,
        url: "https://github.com/pwrdrvr/PwrAgent/pull/1918",
      },
    };
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventHandler = listener;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [
            {
              type: "review",
              id: "review-start",
              review: "Review changes against origin/main",
              displayText: "Review changes against origin/main",
              context,
              turn: {
                id: "turn-review",
                status: "in_progress",
              },
            },
          ],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: liveItemId,
              type: "enteredReviewMode",
              review: "Review changes against origin/main",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
      expect(result.current.entries[0]).toMatchObject({
        type: "review",
        context,
      });
    });
  });

  it("keeps a checked branch that carried no pull request distinguishable", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventHandler = listener;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review-3",
            item: {
              id: "turn-review-3-item",
              type: "exitedReviewMode",
              review: "No findings.",
              data: {
                context: {
                  workspacePath: "/Users/dev/pwrdrvr/PwrAgent",
                  gitBranch: "main",
                  // An answer, not a gap: the card says so out loud.
                  pullRequest: null,
                },
              },
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.entries).toHaveLength(1);
    });
    const entry = result.current.entries[0];
    expect(entry.type === "review" && entry.context?.pullRequest).toBeNull();
  });

  it("keeps a review turn active when a separate turn/started arrives", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.addOptimisticReviewEntry("Review changes against main");
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "turn-review-entered",
              type: "enteredReviewMode",
              review: "Review changes against main",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-stray",
            turn: {
              id: "turn-stray",
              status: "inProgress",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "turn-review-exited",
              type: "exitedReviewMode",
              review: "No findings.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
      expect(
        result.current.entries.filter((entry) => entry.type === "review")
      ).toHaveLength(2);
      expect(
        result.current.entries.some((entry) => entry.id.startsWith("optimistic-review-"))
      ).toBe(false);
    });
  });

  it("keeps a live review authoritative across a transient idle hydration", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let resolveReadThread:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    const readThread = vi.fn(
      async () =>
        await new Promise<AppServerReadThreadResponse>((resolve) => {
          resolveReadThread = resolve;
        })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(agentEventHandler).toBeDefined();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "turn-review-entered",
              type: "enteredReviewMode",
              review: "Review changes against main",
            },
          },
        },
      });
    });

    expect(result.current.activeTurnId).toBe("turn-review");
    expect(result.current.threadBusy).toBe(true);

    await act(async () => {
      resolveReadThread?.({
        backend: "codex",
        fetchedAt: Date.now(),
        threadId: "thread-1",
        threadStatus: "idle",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      });
      await Promise.resolve();
    });

    expect(result.current.activeTurnId).toBe("turn-review");
    expect(result.current.threadBusy).toBe(true);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-stray",
            turn: {
              id: "turn-stray",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.activeTurnId).toBe("turn-review");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/failed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "failed",
              error: {
                message: "Selected model is at capacity. Please try a different model.",
              },
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    });
  });

  it("seeds launchpad review turns before stray turn starts arrive", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          optimisticActiveTurn: {
            id: "turn-review",
            statusText: "Reviewing",
            startedAt: 1_500,
            reviewDisplayText: "Review changes against main",
          },
        },
      })
    );

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.pendingStatusText).toBe("Reviewing");
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          type: "review",
          review: "Review changes against main",
          turn: expect.objectContaining({
            id: "turn-review",
            status: "in_progress",
          }),
        }),
      ]);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            itemId: "call-1",
            requestId: "approval-1",
            reason: "Network access is required.",
            command: "npm view dive",
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.pendingStatusText).toBe("Waiting for approval");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-stray",
            turn: {
              id: "turn-stray",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.activeTurnId).toBe("turn-review");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
    });
  });

  it("repairs a stray launchpad start when optimistic review metadata arrives after events", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result, rerender } = renderHook(
      ({ includeOptimisticReview }: { includeOptimisticReview: boolean }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
            ...(includeOptimisticReview
              ? {
                  optimisticActiveTurn: {
                    id: "turn-review",
                    statusText: "Reviewing",
                    startedAt: 1_500,
                    reviewDisplayText: "Review changes against main",
                  },
                }
              : {}),
          },
        }),
      { initialProps: { includeOptimisticReview: false } }
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-stray",
            turn: {
              id: "turn-stray",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.activeTurnId).toBe("turn-stray");

    rerender({ includeOptimisticReview: true });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.pendingStatusText).toBe("Reviewing");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
    });
  });

  it("does not reseed a launchpad active turn after idle hydration clears it", async () => {
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      threadStatus: "idle" as const,
      replay: {
        entries: [
          {
            type: "review" as const,
            id: "review-1",
            review: "Code review",
            displayText: "Code review",
            createdAt: 2_000,
            turn: {
              id: "turn-review",
              status: "completed" as const,
              startedAt: 1_500,
              completedAt: 2_500,
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const optimisticThread = {
      ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
      optimisticActiveTurn: {
        id: "turn-review",
        statusText: "Reviewing",
        startedAt: 1_500,
        reviewDisplayText: "Review changes against main",
      },
    };

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: optimisticThread,
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
    });

    rerender({ currentThread: { ...optimisticThread } });
    await flushReactUpdates();

    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.threadBusy).toBe(false);
  });

  it("keeps a review turn active when idle hydration contains its in-progress review entry", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      threadStatus: "idle" as const,
      replay: {
        entries: [
          {
            type: "review" as const,
            id: "review-entered",
            review: "Review changes against main",
            displayText: "Review changes against main",
            createdAt: 2_000,
            turn: {
              id: "turn-review",
              status: "in_progress" as const,
              startedAt: 1_500,
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          optimisticActiveTurn: {
            id: "turn-review",
            statusText: "Reviewing",
            startedAt: 1_500,
            reviewDisplayText: "Review changes against main",
          },
        },
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.pendingStatusText).toBe("Reviewing");
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-sibling",
            turn: {
              id: "turn-sibling",
              status: "inProgress",
            },
          },
        },
      });
    });

    expect(result.current.activeTurnId).toBe("turn-review");

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-exited",
              type: "exitedReviewMode",
              review: "No findings.",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "completed",
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });
  });

  it("deduplicates Slack-started review markers by authoritative turn id", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "idle",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-start-live",
              type: "enteredReviewMode",
              review: "Review current changes",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-start-hydrated",
              type: "enteredReviewMode",
              review: "Code review started",
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.entries.filter((entry) =>
        entry.type === "review" && entry.turn?.status === "in_progress"
      )).toHaveLength(1);
    });
  });

  it("does not reconcile historical review starts with a newer turn sharing the same label", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const reviewStartEntry = (reviewNumber: number): AppServerThreadEntry => ({
      type: "review",
      id: `review-start-${reviewNumber}`,
      review: "changes against 'origin/main'",
      displayText: "Review changes against origin/main",
      turn: {
        id: `review-turn-${reviewNumber}`,
        status: "completed",
        completedAt: reviewNumber * 1_000 + 200,
      },
    });
    const reviewResultEntry = (reviewNumber: number): AppServerThreadEntry => ({
      type: "review",
      id: `review-result-${reviewNumber}`,
      review: `${["First", "Second", "Third"][reviewNumber - 1]} review result`,
      createdAt: reviewNumber * 1_000 + 200,
      turn: {
        id: `review-turn-${reviewNumber}`,
        status: "completed",
        completedAt: reviewNumber * 1_000 + 200,
      },
    });
    const historicalEntries: AppServerThreadEntry[] = [
      messageEntry({
        createdAt: 1_000,
        id: "before-review-1",
        text: "Before review one",
      }),
      reviewStartEntry(1),
      reviewResultEntry(1),
      messageEntry({
        createdAt: 2_000,
        id: "before-review-2",
        text: "Before review two",
      }),
      reviewStartEntry(2),
      reviewResultEntry(2),
      messageEntry({
        createdAt: 3_000,
        id: "before-review-3",
        text: "Before review three",
      }),
    ];
    const hydratedLatestEntries: AppServerThreadEntry[] = [
      ...historicalEntries,
      reviewStartEntry(3),
      reviewResultEntry(3),
    ];
    let responseEntries = historicalEntries;
    const readThread = vi.fn(async () =>
      readThreadResponse({
        entries: responseEntries,
        hasPreviousPage: false,
        supportsPagination: false,
      })
    );
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitForThreadHydration(result);

    act(() => {
      result.current.addOptimisticReviewEntry(
        "Review changes against origin/main",
      );
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "review-turn-3",
            item: {
              id: "review-start-3",
              type: "enteredReviewMode",
              review: "changes against 'origin/main'",
              createdAt: 3_100,
            },
          },
        },
      });
    });

    responseEntries = hydratedLatestEntries;
    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "review-turn-3",
            item: {
              id: "review-result-3",
              type: "exitedReviewMode",
              review: "Third review result",
              createdAt: 3_200,
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId: "review-turn-3",
            turn: {
              id: "review-turn-3",
              status: "completed",
              completedAt: 3_200,
              output: [],
            },
          },
        },
      });
    });

    await waitFor(() => {
      expect(readThread.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(result.current.entries.map((entry) => entry.id)).toEqual(
        hydratedLatestEntries.map((entry) => entry.id),
      );
    });
    expect(
      result.current.entries
        .filter((entry) => entry.type === "review" && entry.displayText)
        .map((entry) => ({
          createdAt: entry.createdAt,
          id: entry.id,
          turnId: entry.turn?.id,
        })),
    ).toEqual([
      {
        createdAt: undefined,
        id: "review-start-1",
        turnId: "review-turn-1",
      },
      {
        createdAt: undefined,
        id: "review-start-2",
        turnId: "review-turn-2",
      },
      {
        createdAt: 3_100_000,
        id: "review-start-3",
        turnId: "review-turn-3",
      },
    ]);
  });

  it("does not clear a just-started review from a racing idle hydration", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let resolveRead:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    const readThread = vi.fn(() => new Promise<AppServerReadThreadResponse>((resolve) => {
      resolveRead = resolve;
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-start",
              type: "enteredReviewMode",
              review: "Review current changes",
            },
          },
        },
      });
      resolveRead?.({
        backend: "codex",
        fetchedAt: Date.now(),
        threadId: "thread-1",
        threadStatus: "idle",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.threadBusy).toBe(true);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/failed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            turn: {
              id: "turn-review",
              status: "failed",
              error: { message: "capacity exhausted" },
            },
          },
        },
      });
    });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });
  });

  it("rechecks an idle review after the own-update grace period", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    let resolveFirstRead:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    let readCount = 0;
    const idleResponse = (): AppServerReadThreadResponse => ({
      backend: "codex",
      fetchedAt: Date.now(),
      threadId: "thread-1",
      threadStatus: "idle",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const readThread = vi.fn(() => {
      readCount += 1;
      if (readCount === 1) {
        return new Promise<AppServerReadThreadResponse>((resolve) => {
          resolveFirstRead = resolve;
        });
      }
      return Promise.resolve(idleResponse());
    });
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread,
    };
    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-review",
            item: {
              id: "review-start",
              type: "enteredReviewMode",
              review: "Review current changes",
            },
          },
        },
      });
      resolveFirstRead?.(idleResponse());
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.threadBusy).toBe(true);
    });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    }, { timeout: 2_500 });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });
  });

  it("rechecks an idle optimistic review before clearing missed terminal state", async () => {
    let resolveFirstRead:
      | ((response: AppServerReadThreadResponse) => void)
      | undefined;
    let readCount = 0;
    const idleResponse = (): AppServerReadThreadResponse => ({
      backend: "codex",
      fetchedAt: Date.now(),
      threadId: "thread-1",
      threadStatus: "idle",
      replay: {
        entries: [],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    });
    const readThread = vi.fn(() => {
      readCount += 1;
      if (readCount === 1) {
        return new Promise<AppServerReadThreadResponse>((resolve) => {
          resolveFirstRead = resolve;
        });
      }
      return Promise.resolve(idleResponse());
    });
    const optimisticThread = {
      ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
      optimisticActiveTurn: {
        id: "turn-review",
        statusText: "Reviewing",
        startedAt: Date.now(),
        reviewDisplayText: "Review changes against main",
      },
    };
    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi: { readThread },
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: optimisticThread,
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.threadBusy).toBe(true);
    });

    act(() => {
      resolveFirstRead?.(idleResponse());
    });

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-review");
      expect(result.current.threadBusy).toBe(true);
    });
    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    }, { timeout: 2_500 });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });

    rerender({ currentThread: { ...optimisticThread } });
    await flushReactUpdates();

    expect(result.current.activeTurnId).toBeUndefined();
    expect(result.current.threadBusy).toBe(false);
  });

  it("clears stale review thinking when idle hydration also contains a terminal review entry", async () => {
    const readThread = vi.fn(async ({ backend, threadId }) => ({
      backend: backend ?? "codex",
      fetchedAt: Date.now(),
      threadId,
      threadStatus: "idle" as const,
      replay: {
        entries: [
          {
            type: "review" as const,
            id: "review-entered",
            review: "Review changes against main",
            displayText: "Review changes against main",
            createdAt: 2_000,
            turn: {
              id: "turn-review",
              status: "in_progress" as const,
              startedAt: 1_500,
            },
          },
          {
            type: "review" as const,
            id: "review-exited",
            review: "No findings.",
            createdAt: 3_000,
            turn: {
              id: "turn-review",
              status: "completed" as const,
              startedAt: 1_500,
              completedAt: 3_000,
            },
          },
        ],
        messages: [],
        pagination: {
          supportsPagination: false,
          hasPreviousPage: false,
        },
      },
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          optimisticActiveTurn: {
            id: "turn-review",
            statusText: "Reviewing",
            startedAt: 1_500,
            reviewDisplayText: "Review changes against main",
          },
        },
      })
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.pendingStatusText).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });
  });

  it("seeds launchpad active turns alongside optimistic user messages", async () => {
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          optimisticUserMessage: {
            text: "Start from launchpad",
            createdAt: 1_500,
          },
          optimisticActiveTurn: {
            id: "turn-1",
            statusText: "Thinking",
            startedAt: 1_500,
          },
        },
      })
    );

    await waitFor(() => {
      expect(result.current.activeTurnId).toBe("turn-1");
      expect(result.current.pendingStatusText).toBe("Thinking");
      expect(result.current.entries).toEqual([
        expect.objectContaining({
          type: "message",
          role: "user",
          text: "Start from launchpad",
        }),
      ]);
    });
  });

  it("stores context window usage from token usage notifications", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: {
                totalTokens: 96_000,
              },
              modelContextWindow: 128_000,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toEqual({
      cachedInputTokens: undefined,
      cumulativeCachedInputTokens: undefined,
      cumulativeInputTokens: undefined,
      cumulativeOutputTokens: undefined,
      cumulativeReasoningOutputTokens: undefined,
      cumulativeTotalTokens: undefined,
      inputTokens: undefined,
      modelContextWindow: 128_000,
      outputTokens: undefined,
      phase: 6,
      reasoningOutputTokens: undefined,
      remainingPercent: 25,
      remainingTokens: 32_000,
      totalTokens: 96_000,
      usedPercent: 75,
    });
  });

  it("derives context window usage from captured input and output token breakdowns", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              total: {
                inputTokens: 1_200,
                outputTokens: 12,
              },
              modelContextWindow: 258_400,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toEqual({
      cachedInputTokens: undefined,
      cumulativeCachedInputTokens: undefined,
      cumulativeInputTokens: undefined,
      cumulativeOutputTokens: undefined,
      cumulativeReasoningOutputTokens: undefined,
      cumulativeTotalTokens: undefined,
      inputTokens: 1_200,
      modelContextWindow: 258_400,
      outputTokens: 12,
      phase: 0,
      reasoningOutputTokens: undefined,
      remainingPercent: ((258_400 - 1_212) / 258_400) * 100,
      remainingTokens: 258_400 - 1_212,
      totalTokens: 1_212,
      usedPercent: (1_212 / 258_400) * 100,
    });
  });

  it("prefers last token usage over cumulative session usage for context fill", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitFor(() => {
      expect(desktopApi.readThread).toHaveBeenCalled();
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 20_663,
                cached_input_tokens: 20_352,
                output_tokens: 45,
                total_tokens: 20_708,
              },
              total_token_usage: {
                input_tokens: 41_267,
                cached_input_tokens: 23_808,
                output_tokens: 75,
                reasoning_output_tokens: 30,
                total_tokens: 41_342,
              },
              model_context_window: 258_400,
            },
          },
        },
      });
    });

    expect(result.current.contextWindow).toMatchObject({
      cachedInputTokens: 20_352,
      cumulativeCachedInputTokens: 23_808,
      cumulativeInputTokens: 41_267,
      cumulativeOutputTokens: 75,
      cumulativeReasoningOutputTokens: 30,
      cumulativeTotalTokens: 41_342,
      inputTokens: 20_663,
      modelContextWindow: 258_400,
      outputTokens: 45,
      phase: 0,
      totalTokens: 20_708,
      usedPercent: (20_708 / 258_400) * 100,
    });
  });

  it("does not keep list thinking after completed live activity is retained", async () => {
    const agentEventListeners = new Set<
      Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
    >();
    const desktopApi: DesktopApi = {
      onAgentEvent: (listener) => {
        agentEventListeners.add(listener);
        return () => {
          agentEventListeners.delete(listener);
        };
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "inProgress",
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "command-1",
                type: "commandExecution",
                status: "in_progress",
                command: "pnpm test",
              },
            },
          },
        });
      }
    });

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    act(() => {
      for (const listener of agentEventListeners) {
        listener({
          backend: "codex",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "command-1",
                type: "commandExecution",
                status: "completed",
                command: "pnpm test",
                aggregatedOutput: "Tests passed.",
              },
            },
          },
        });
        listener({
          backend: "codex",
          notification: {
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: {
                id: "turn-1",
                status: "completed",
                output: [],
              },
            },
          },
        });
      }
    });

    expect(result.current.entries).toEqual([
      expect.objectContaining({
        type: "activity",
        status: "completed",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
        }),
      }),
    ]);
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
  });

  it("does not keep list thinking from completed usage with stale turn metadata", async () => {
    let agentEventHandler: Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0] | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      result.current.setActiveTurnId("turn-2");
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              last_token_usage: {
                input_tokens: 1_200,
                cached_input_tokens: 200,
                output_tokens: 50,
                reasoning_output_tokens: 10,
              },
            },
          },
        },
      });
    });

    expect(result.current.entries).toEqual([
      expect.objectContaining({
        id: "live-token-usage-turn-1",
        status: "completed",
        type: "activity",
        turn: expect.objectContaining({
          id: "turn-1",
          status: "completed",
        }),
      }),
    ]);
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    act(() => {
      result.current.setActiveTurnId(undefined);
    });

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
  });

  it("logs and clears stale thinking when a selected thread read proves the thread is idle", async () => {
    const logRendererDiagnostic = vi.fn(async () => undefined);
    const readThread = vi
      .fn()
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }))
      .mockImplementationOnce(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "idle",
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }));
    const desktopApi: DesktopApi = {
      logRendererDiagnostic,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ currentThread }) =>
        useThreadSessionState({
          desktopApi,
          thread: currentThread,
        }),
      {
        initialProps: {
          currentThread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
        },
      }
    );

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.setPendingStatusText("Thinking");
    });

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    rerender({
      currentThread: buildThread({ id: "thread-1", updatedAt: 2_000 }),
    });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    });

    expect(logRendererDiagnostic).toHaveBeenCalledTimes(1);
    expect(logRendererDiagnostic).toHaveBeenCalledWith({
      details: expect.objectContaining({
        threadKey: "codex:thread-1",
        threadStatus: "idle",
        reasons: expect.arrayContaining([
          expect.objectContaining({ kind: "pendingStatus" }),
        ]),
      }),
      level: "warn",
      message: "stale thinking state cleared after idle thread read",
    });
  });

  it("rehydrates stale thinking when navigation reports a missed remote completion", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const completedTurn = {
      ...activeTurn,
      status: "completed" as const,
      completedAt: 6_000,
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          {
            type: "message",
            id: "commentary-1",
            role: "assistant",
            phase: "commentary",
            text: "Working remotely.",
            turn: activeTurn,
          },
        ],
        hasPreviousPage: false,
        threadStatus: "active",
      }))
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          {
            type: "message",
            id: "final-1",
            role: "assistant",
            phase: "final",
            text: "Done.",
            turn: completedTurn,
          },
        ],
        hasPreviousPage: false,
        threadStatus: "idle",
      }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };

    const { result, rerender } = renderHook(
      ({ threadStatus }: { threadStatus: "active" | "idle" }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
            threadStatus,
          },
        }),
      {
        initialProps: {
          threadStatus: "active" as "active" | "idle",
        },
      }
    );

    await waitForThreadHydration(result);
    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);

    // Simulate a federation viewer that missed both terminal events. Its
    // later navigation snapshot changes only the status; updatedAt is the
    // same as the already-hydrated active snapshot.
    rerender({ threadStatus: "idle" });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    }, { timeout: 3_000 });
    await waitFor(() => {
      expect(result.current.activeTurnId).toBeUndefined();
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });
  });

  it("rehydrates an active remote thread when its navigation summary advances", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const pendingRequest: AppServerToolRequestUserInputNotification = {
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "input-1",
        requestId: "input-request-1",
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "How should I proceed?",
            isOther: false,
            isSecret: false,
            options: [
              {
                label: "Skip backport (Recommended)",
                description: "The target branch has no affected suite.",
              },
            ],
          },
        ],
      },
    };
    const initialEntry: AppServerThreadMessageEntry = {
      type: "message",
      id: "user-1",
      role: "user",
      text: "Backport the change.",
      turn: activeTurn,
    };
    const caughtUpEntry: AppServerThreadMessageEntry = {
      type: "message",
      id: "commentary-1",
      role: "assistant",
      phase: "commentary",
      text: "The release branch has no affected suite.",
      turn: activeTurn,
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [initialEntry],
        hasPreviousPage: false,
        threadStatus: "active",
      }))
      .mockResolvedValueOnce({
        ...readThreadResponse({
          entries: [initialEntry, caughtUpEntry],
          hasPreviousPage: false,
          threadStatus: "active",
        }),
        pendingRequest,
      });
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const remoteThread = (updatedAt: number): NavigationThreadSummary => ({
      ...buildThread({ id: "thread-1", updatedAt }),
      threadStatus: "active",
      federation: {
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "owner-m5",
          },
          threadId: "thread-1",
        },
        instanceLabel: "Remote M5",
        capabilities: [
          "thread_detail",
          "pending_request_control",
          "event_subscriptions",
        ],
      },
    });

    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          thread: remoteThread(updatedAt),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    expect(readThread).toHaveBeenCalledTimes(1);
    expect(result.current.activeTurnId).toBe("turn-1");
    expect(result.current.pendingUserInput).toBeUndefined();

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(readThread).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(result.current.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "commentary-1",
            text: "The release branch has no affected suite.",
          }),
        ]),
      );
      expect(result.current.pendingStatusText).toBe("Waiting for input");
      expect(result.current.pendingUserInput).toMatchObject({
        requestId: "input-request-1",
        questions: [{ id: "scope" }],
      });
    });
    expect(readThread).toHaveBeenLastCalledWith(expect.objectContaining({
      federationTarget: {
        scope: "remote",
        instanceId: "owner-m5",
      },
      threadId: "thread-1",
    }));
  });

  it("does not immediately retry a failed active remote rehydration", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const readThread = vi
      .fn()
      .mockResolvedValueOnce(readThreadResponse({
        entries: [
          {
            type: "message",
            id: "user-1",
            role: "user",
            text: "Continue remotely.",
            turn: activeTurn,
          },
        ],
        hasPreviousPage: false,
        threadStatus: "active",
      }))
      .mockRejectedValue(new Error("Remote federation unavailable"));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const remoteThread = (updatedAt: number): NavigationThreadSummary => ({
      ...buildThread({ id: "thread-1", updatedAt }),
      threadStatus: "active",
      federation: {
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "owner-m5",
          },
          threadId: "thread-1",
        },
        instanceLabel: "Remote M5",
        capabilities: [
          "thread_detail",
          "event_subscriptions",
        ],
      },
    });

    const { result, rerender } = renderHook(
      ({ updatedAt }: { updatedAt: number }) =>
        useThreadSessionState({
          desktopApi,
          thread: remoteThread(updatedAt),
        }),
      { initialProps: { updatedAt: 1_000 } },
    );

    await waitForThreadHydration(result);
    expect(readThread).toHaveBeenCalledTimes(1);

    rerender({ updatedAt: 2_000 });

    await waitFor(() => {
      expect(result.current.error).toBe("Remote federation unavailable");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(readThread).toHaveBeenCalledTimes(2);
    expect(result.current.activeTurnId).toBe("turn-1");
  });

  it("cancels missed-completion reconciliation when navigation becomes active again", async () => {
    const activeTurn = {
      id: "turn-1",
      status: "in_progress" as const,
      startedAt: 5_000,
    };
    const readThread = vi.fn(async () => readThreadResponse({
      entries: [
        {
          type: "message",
          id: "commentary-1",
          role: "assistant",
          phase: "commentary",
          text: "Still working.",
          turn: activeTurn,
        },
      ],
      hasPreviousPage: false,
      threadStatus: "active",
    }));
    const desktopApi: DesktopApi = {
      onAgentEvent: () => () => undefined,
      readThread,
    };
    const { result, rerender } = renderHook(
      ({ threadStatus }: { threadStatus: "active" | "idle" }) =>
        useThreadSessionState({
          desktopApi,
          thread: {
            ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
            threadStatus,
          },
        }),
      {
        initialProps: {
          threadStatus: "active" as "active" | "idle",
        },
      }
    );

    await waitForThreadHydration(result);
    expect(result.current.activeTurnId).toBe("turn-1");
    expect(readThread).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    try {
      rerender({ threadStatus: "idle" });
      rerender({ threadStatus: "active" });

      act(() => {
        vi.advanceTimersByTime(2_000);
      });

      expect(readThread).toHaveBeenCalledTimes(1);
      expect(result.current.activeTurnId).toBe("turn-1");
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);
      expect(result.current.threadBusy).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores thinking from active backend status after renderer HMR", async () => {
    let agentEventHandler:
      | Parameters<NonNullable<DesktopApi["onAgentEvent"]>>[0]
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback;
        return () => undefined;
      },
      readThread: vi.fn(async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        threadStatus: "active" as const,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      })),
    };

    const { result, rerender } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: {
          ...buildThread({ id: "thread-1", updatedAt: 1_000 }),
          threadStatus: "active" as const,
        },
      })
    );

    await waitFor(() => {
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBe(true);
      expect(result.current.pendingStatusText).toBe("Thinking");
      expect(result.current.threadBusy).toBe(true);
    });

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });
    });

    await waitFor(() => {
      expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
      expect(result.current.threadBusy).toBe(false);
    });

    rerender();

    expect(result.current.thinkingThreadKeys["codex:thread-1"]).toBeUndefined();
    expect(result.current.pendingStatusText).toBeUndefined();
    expect(result.current.threadBusy).toBe(false);
  });

  it("renders item/fileChange/outputDelta as a Changed file activity entry", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-file-change",
            delta:
              "Success. Updated the following files:\nM apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx\n",
          },
        },
      });
    });

    const fileChange = result.current.entries.find(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && entry.id === "live-file-change-call-file-change"
    );
    expect(fileChange).toBeDefined();
    expect(fileChange?.summary).toBe("Changed 1 file");
    expect(fileChange?.turn?.id).toBe("turn-1");
    expect(fileChange?.details).toEqual([
      expect.objectContaining({
        kind: "write",
        label: "Modified TranscriptList.tsx",
        path: "apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx",
      }),
    ]);
    // Sequence must be allocated so mergeTranscriptEntries' tiebreak can
    // place file-change correctly when wall-clock timestamps collide.
    expect(typeof readRendererSequence(fileChange)).toBe("number");
  });

  it("collapses add+delete deltas for the same path into a Recreated detail", async () => {
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-file-change",
            delta:
              "Success. Updated the following files:\nA /Users/fixture-user/github/PwrAgent/.local/PR.md\nD /Users/fixture-user/github/PwrAgent/.local/PR.md\n",
          },
        },
      });
    });

    const fileChange = result.current.entries.find(
      (entry): entry is AppServerThreadActivityEntry =>
        entry.type === "activity" && entry.id === "live-file-change-call-file-change"
    );
    expect(fileChange?.summary).toBe("Changed 1 file");
    expect(fileChange?.details).toEqual([
      expect.objectContaining({
        kind: "write",
        label: "Recreated PR.md",
        path: "/Users/fixture-user/github/PwrAgent/.local/PR.md",
      }),
    ]);
  });

  it("places file-change between earlier tool activity and a later assistant commentary message", async () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now++);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "command-typecheck",
              type: "commandExecution",
              command: "pnpm typecheck",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-file-change",
            delta:
              "Success. Updated the following files:\nM apps/desktop/src/renderer/src/features/composer/Composer.tsx\n",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-focused-tests",
            delta: "The focused composer tests are green.",
          },
        },
      });
      // Force the pending assistant message into optimisticEntries so it
      // shows up in `entries` for the ordering assertion below. In live
      // usage the equivalent flush happens when the next `item/started`
      // arrives (e.g. the e2e command in plan-autocomplete-order).
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "command-e2e",
              type: "commandExecution",
              command: "pnpm test:e2e",
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:pnpm typecheck",
      "activity:Changed 1 file",
      "message:The focused composer tests are green.",
      "activity:pnpm test",
    ]);
  });

  it("orders file-change before later activity by rendererSequence even when wall-clock ties", async () => {
    // Reproduces the plan-autocomplete-order flake (PR #492 era): when CI
    // batches a burst of IPC events into one React render commit, the
    // render-time Date.now() stamps for tools/messages/etc. land in the
    // same ms as the file-change stamp. With the old ThreadView-owned
    // pendingProtocolActivityEntry path, file-change had no
    // rendererSequence and would fall through to "push to end". After
    // routing through useThreadSessionState the entry gets a sequence
    // from the same allocator, and mergeTranscriptEntries' tiebreak puts
    // it in the right slot regardless of clock collisions.
    vi.spyOn(Date, "now").mockReturnValue(50_000);
    let agentEventHandler:
      | ((event: {
          backend: "codex" | "acp:grok";
          notification: {
            method: string;
            params: Record<string, unknown>;
          };
        }) => void)
      | undefined;
    const desktopApi: DesktopApi = {
      onAgentEvent: (callback) => {
        agentEventHandler = callback as typeof agentEventHandler;
        return () => undefined;
      },
      readThread: async ({ backend, threadId }) => ({
        backend: backend ?? "codex",
        fetchedAt: Date.now(),
        threadId,
        replay: {
          entries: [],
          messages: [],
          pagination: {
            supportsPagination: false,
            hasPreviousPage: false,
          },
        },
      }),
    };

    const { result } = renderHook(() =>
      useThreadSessionState({
        desktopApi,
        thread: buildThread({ id: "thread-1", updatedAt: 1_000 }),
      })
    );

    await waitForThreadHydration(result);

    act(() => {
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "inProgress" },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "command-typecheck",
              type: "commandExecution",
              command: "pnpm typecheck",
            },
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-file-change",
            delta:
              "Success. Updated the following files:\nM apps/desktop/src/renderer/src/features/composer/Composer.tsx\n",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-focused-tests",
            delta: "The focused composer tests are green.",
          },
        },
      });
      agentEventHandler?.({
        backend: "codex",
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "command-e2e",
              type: "commandExecution",
              command: "pnpm test:e2e",
            },
          },
        },
      });
    });

    expect(transcriptLabels(result.current.entries)).toEqual([
      "activity:pnpm typecheck",
      "activity:Changed 1 file",
      "message:The focused composer tests are green.",
      "activity:pnpm test",
    ]);
  });
});
